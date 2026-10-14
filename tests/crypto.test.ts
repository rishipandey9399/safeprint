import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptFile,
  decryptFile,
  generateOtp,
  generateShareCode,
  generateToken,
  hashToken,
  hmacOtp,
  timingSafeEqualHex,
} from "@/lib/crypto";

test("OTP is always 6 digits and varies per session", () => {
  const otps = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const otp = generateOtp();
    assert.match(otp, /^\d{6}$/);
    otps.add(otp);
  }
  // 500 draws from 1e6 values: collisions are possible but a fixed OTP is not.
  assert.ok(otps.size > 490, `expected fresh OTPs, got ${otps.size} unique of 500`);
});

test("share codes avoid ambiguous characters", () => {
  for (let i = 0; i < 500; i++) assert.match(generateShareCode(), /^[2-9A-HJKMNP-Z]{6}$/);
});

test("OTP HMAC matches only the same code, compared timing-safe", () => {
  assert.ok(timingSafeEqualHex(hmacOtp("123456"), hmacOtp("123456")));
  assert.ok(!timingSafeEqualHex(hmacOtp("123456"), hmacOtp("123457")));
  assert.ok(!timingSafeEqualHex(hmacOtp("123456"), "abcd"));
});

test("tokens are 64 hex chars and stored only as hashes", () => {
  const token = generateToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
});

test("envelope encryption round-trips and blank keys can't decrypt", () => {
  const plain = Buffer.from("%PDF-1.4 secret aadhaar");
  const { ciphertext, ...keys } = encryptFile(plain);
  assert.ok(!ciphertext.includes(plain));
  assert.deepEqual(decryptFile(ciphertext, keys), plain);
  assert.throws(() => decryptFile(ciphertext, { ...keys, wrappedKey: "", keyTag: "" }));
});
