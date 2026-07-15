import { config } from "./config";

/**
 * Background sweep: finalizes (deletes + crypto-shreds) any session whose
 * 30-minute TTL passed without a print. Started once from instrumentation.ts.
 */
const globalWithCleanup = global as typeof globalThis & { _cleanupStarted?: boolean };

export function startCleanupJob(): void {
  if (globalWithCleanup._cleanupStarted) return;
  globalWithCleanup._cleanupStarted = true;

  const tick = async () => {
    try {
      const { connectDb } = await import("./db");
      const { sweepExpiredSessions } = await import("./lifecycle");
      await connectDb();
      const n = await sweepExpiredSessions();
      if (n > 0) console.log(`[SafePrint cleanup] finalized ${n} expired session(s)`);
    } catch (err) {
      console.error("[SafePrint cleanup] sweep failed:", err);
    }
  };

  setInterval(tick, config.cleanupIntervalMs);
  void tick();
  console.log(
    `[SafePrint cleanup] job started (every ${config.cleanupIntervalMs / 1000}s, TTL ${config.sessionTtlSeconds}s)`
  );
}
