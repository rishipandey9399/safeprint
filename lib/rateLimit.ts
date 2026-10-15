import type { Redis } from "ioredis";
import { config } from "./config";

/**
 * Rate limiter. With REDIS_URL set, counters live in Redis (fixed window,
 * INCR + PEXPIRE) so limits survive restarts and hold across instances.
 * Without it — or if Redis errors — an in-memory sliding window is used,
 * which is fine for a single-process dev server.
 */
const globalWithBuckets = global as typeof globalThis & {
  _rateBuckets?: Map<string, number[]>;
  _rateRedis?: Redis | null;
  _rateRedisWarned?: boolean;
};
const buckets = (globalWithBuckets._rateBuckets ??= new Map<string, number[]>());

// Keys can be attacker-chosen (e.g. guessed share codes), so idle buckets are
// swept periodically rather than kept forever.
let callsSinceSweep = 0;
const SWEEP_EVERY = 1000;
const MAX_WINDOW_MS = 60 * 60 * 1000;

function sweepIdleBuckets(now: number) {
  for (const [k, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > MAX_WINDOW_MS) buckets.delete(k);
  }
}

export function memoryRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (++callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepIdleBuckets(now);
  }
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

async function getRedis(): Promise<Redis | null> {
  if (!config.redisUrl) return null;
  if (globalWithBuckets._rateRedis === undefined) {
    const { Redis } = await import("ioredis");
    globalWithBuckets._rateRedis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // Errors are surfaced per-call below; keep the client from crashing the process.
    globalWithBuckets._rateRedis.on("error", () => {});
  }
  return globalWithBuckets._rateRedis;
}

export async function rateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return memoryRateLimit(key, max, windowMs);

  try {
    const window = Math.floor(Date.now() / windowMs);
    const redisKey = `safeprint:rl:${key}:${window}`;
    const [[, count]] = (await redis.multi().incr(redisKey).pexpire(redisKey, windowMs).exec()) as [
      [Error | null, number],
      [Error | null, number],
    ];
    return count <= max;
  } catch (err) {
    if (!globalWithBuckets._rateRedisWarned) {
      globalWithBuckets._rateRedisWarned = true;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[SafePrint] Redis rate limiter unavailable, using in-memory fallback: ${reason}`);
    }
    return memoryRateLimit(key, max, windowMs);
  }
}

/**
 * True when `key` has already used up `max` hits in the current window —
 * without counting a hit. For brakes that trip on failures only.
 */
export async function isLimited(key: string, max: number, windowMs: number): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    try {
      const count = Number(await redis.get(`safeprint:rl:${key}:${Math.floor(Date.now() / windowMs)}`)) || 0;
      return count >= max;
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  return (buckets.get(key) ?? []).filter((t) => now - t < windowMs).length >= max;
}

/**
 * The client's IP as seen by OUR proxy. X-Forwarded-For is a list the
 * client can pre-fill; each trusted proxy appends the address it received
 * the request from. So the only trustworthy entry is the one our outermost
 * proxy appended: counted `TRUST_PROXY_HOPS` from the right (default 1 —
 * one nginx / load balancer in front). The leftmost entry is attacker-chosen
 * and must never be used. With 0 hops (no proxy) the header is ignored
 * entirely; route handlers can't see the socket address, so every client
 * then shares one bucket — run behind a proxy in production. (Exposed
 * directly, Next's server fills in X-Forwarded-For with the socket address
 * only when the client sent none, and keeps a client-sent one — so a direct
 * deployment can't tell real from forged.)
 */
export function getClientIp(req: Request): string {
  const hops = config.trustProxyHops;
  const fwd = req.headers.get("x-forwarded-for");
  if (hops > 0 && fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip.slice(0, 64);
  }
  return "direct";
}
