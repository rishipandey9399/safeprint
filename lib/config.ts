import crypto from "crypto";

// Deterministic dev-only key so hot reloads / restarts can still decrypt
// in-flight sessions. MASTER_KEY must be set for anything beyond local dev.
const DEV_MASTER_KEY = crypto
  .createHash("sha256")
  .update("safeprint-dev-master-key-do-not-use-in-prod")
  .digest();

const masterKey = process.env.MASTER_KEY
  ? Buffer.from(process.env.MASTER_KEY, "hex")
  : DEV_MASTER_KEY;

if (masterKey.length !== 32) {
  throw new Error("MASTER_KEY must be 64 hex characters (32 bytes)");
}

export const config = {
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/safeprint",
  masterKey,
  usingDevMasterKey: !process.env.MASTER_KEY,
  storageDriver: process.env.STORAGE_DRIVER ?? "local",
  localStoreDir: process.env.LOCAL_STORE_DIR ?? ".safeprint-store",
  gcsBucket: process.env.GCS_BUCKET ?? "",
  sessionTtlSeconds: parseInt(process.env.SESSION_TTL_SECONDS ?? "1800", 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS ?? "60000", 10),
  maxFileBytes: 15 * 1024 * 1024,
  maxOtpAttempts: 5,
  maxPrintAttempts: 2,
  maxRenderFetches: 20,
};
