/**
 * In-memory sliding-window rate limiter — sufficient for a single-process
 * MVP; production would move this to Redis or similar.
 */
const globalWithBuckets = global as typeof globalThis & {
  _rateBuckets?: Map<string, number[]>;
};
const buckets = (globalWithBuckets._rateBuckets ??= new Map<string, number[]>());

export function rateLimit(key: string, max: number, windowMs: number): boolean {
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

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
