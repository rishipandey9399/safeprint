import crypto from "crypto";

// Deterministic dev-only key so hot reloads / restarts can still decrypt
// in-flight sessions. MASTER_KEY must be set for anything beyond local dev.
const DEV_MASTER_KEY = crypto
  .createHash("sha256")
  .update("safeprint-dev-master-key-do-not-use-in-prod")
  .digest();

const isProduction = process.env.NODE_ENV === "production";
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

// The dev key is public (it's in this file) — encrypting real documents or
// keying OTP HMACs with it would be no protection at all.
if (isProduction && !isBuildPhase && !process.env.MASTER_KEY) {
  throw new Error(
    "MASTER_KEY is required in production (64 hex chars). " +
      `Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}

// The Word editor's script runs inside the shop's page, so the Document
// Server must be reached over TLS in production (localhost aside, for testing).
if (isProduction && !isBuildPhase && process.env.ONLYOFFICE_URL) {
  const u = new URL(process.env.ONLYOFFICE_URL);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) {
    throw new Error("ONLYOFFICE_URL must use https:// in production.");
  }
}

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
  redisUrl: process.env.REDIS_URL ?? "",
  sessionTtlSeconds: parseInt(process.env.SESSION_TTL_SECONDS ?? "1800", 10),
  otpTtlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? "600", 10),
  approvalTimeoutSeconds: parseInt(process.env.APPROVAL_TIMEOUT_SECONDS ?? "120", 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS ?? "60000", 10),
  // Skips the citizen's Allow tap — for the agent selftest and automated
  // tests only. Never honoured in production.
  autoApprove: !isProduction && process.env.SAFEPRINT_AUTO_APPROVE === "1",
  maxFileBytes: 15 * 1024 * 1024,
  maxOtpAttempts: 5,
  maxOtpRegenerations: 5,
  maxPrintAttempts: 2,
  maxRenderFetches: 20,
  // Shop-side editing (citizen consents up front, then approves the result).
  maxEditRounds: 3,
  editTtlExtensionSeconds: parseInt(process.env.EDIT_TTL_EXTENSION_SECONDS ?? "900", 10),
  maxEditPages: 50,
  // ONLYOFFICE Document Server for Word conversion + editing. Unset = Word
  // uploads are refused and only the image editor is offered.
  onlyofficeUrl: (process.env.ONLYOFFICE_URL ?? "").replace(/\/+$/, ""),
  onlyofficeJwtSecret: process.env.ONLYOFFICE_JWT_SECRET ?? "",
  // How the Document Server reaches this app (server-to-server); defaults to
  // the public URL the request came in on.
  internalBaseUrl: (process.env.SAFEPRINT_INTERNAL_URL ?? "").replace(/\/+$/, ""),
  // How many proxies in front of the app append to X-Forwarded-For (see
  // getClientIp). 1 = a single nginx / load balancer; 0 = none.
  // Failed OTP checks per minute across the whole service (requests without a
  // counter key) before unpaired verification pauses — stops share-code scanning.
  verifyGlobalMissesPerMinute: parseInt(process.env.VERIFY_GLOBAL_MISS_LIMIT ?? "300", 10),
  // OTP checks per minute against any single share code, whatever the IP.
  verifyPerCodePerMinute: 5,
  // Ended sessions keep a scrubbed record (no file name) this long, then are
  // deleted by a TTL index; audit entries likewise. Days.
  sessionRetentionDays: Math.max(1, parseInt(process.env.SESSION_RETENTION_DAYS ?? "30", 10) || 30),
  auditRetentionDays: Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS ?? "90", 10) || 90),
  trustProxyHops: Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10) || 0),
  // Word conversions at once per app process, how many more may wait, and for how long.
  wordConversionConcurrency: Math.max(1, parseInt(process.env.WORD_CONVERSION_CONCURRENCY ?? "2", 10)),
  wordConversionQueue: Math.max(0, parseInt(process.env.WORD_CONVERSION_QUEUE ?? "10", 10)),
  wordConversionWaitMs: parseInt(process.env.WORD_CONVERSION_WAIT_MS ?? "20000", 10),
};

export function wordEditingEnabled(): boolean {
  return !!(config.onlyofficeUrl && config.onlyofficeJwtSecret);
}
