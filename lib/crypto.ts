import crypto from "crypto";
import { config } from "./config";

/**
 * Envelope encryption: each file gets a random 256-bit DEK (data encryption
 * key). The file is encrypted with the DEK, and the DEK is wrapped with the
 * master key. Deleting the wrapped key from the session document makes the
 * stored blob permanently unreadable even if the blob itself survives
 * (crypto-shredding).
 */
export interface FileKeyMaterial {
  fileIv: string;
  fileTag: string;
  wrappedKey: string;
  keyIv: string;
  keyTag: string;
}

export function encryptFile(plain: Buffer): { ciphertext: Buffer } & FileKeyMaterial {
  const dek = crypto.randomBytes(32);
  const fileIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, fileIv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const fileTag = cipher.getAuthTag();

  const keyIv = crypto.randomBytes(12);
  const keyCipher = crypto.createCipheriv("aes-256-gcm", config.masterKey, keyIv);
  const wrappedKey = Buffer.concat([keyCipher.update(dek), keyCipher.final()]);
  const keyTag = keyCipher.getAuthTag();

  return {
    ciphertext,
    fileIv: fileIv.toString("hex"),
    fileTag: fileTag.toString("hex"),
    wrappedKey: wrappedKey.toString("hex"),
    keyIv: keyIv.toString("hex"),
    keyTag: keyTag.toString("hex"),
  };
}

export function decryptFile(ciphertext: Buffer, keys: FileKeyMaterial): Buffer {
  const keyDecipher = crypto.createDecipheriv(
    "aes-256-gcm",
    config.masterKey,
    Buffer.from(keys.keyIv, "hex")
  );
  keyDecipher.setAuthTag(Buffer.from(keys.keyTag, "hex"));
  const dek = Buffer.concat([
    keyDecipher.update(Buffer.from(keys.wrappedKey, "hex")),
    keyDecipher.final(),
  ]);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    dek,
    Buffer.from(keys.fileIv, "hex")
  );
  decipher.setAuthTag(Buffer.from(keys.fileTag, "hex"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Tokens are stored only as SHA-256 hashes — a DB leak alone grants nothing. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// The OTP key is derived from the master key, not the master key itself, so
// no single key serves both key-wrapping (AES) and OTP hashing (HMAC).
const otpKey = Buffer.from(crypto.hkdfSync("sha256", config.masterKey, Buffer.alloc(0), "safeprint/otp/v1", 32));

/** OTPs are stored as HMACs under a derived key, never in plaintext. */
export function hmacOtp(code: string): string {
  return crypto.createHmac("sha256", otpKey).update(code).digest("hex");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Unambiguous alphabet: no 0/O, 1/I/L — operators read these over a counter.
const SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateShareCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += SHARE_CODE_ALPHABET[crypto.randomInt(0, SHARE_CODE_ALPHABET.length)];
  }
  return code;
}
