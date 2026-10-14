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

export function memoryRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
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

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
