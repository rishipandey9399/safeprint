import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRateLimit, rateLimit } from "@/lib/rateLimit";

test("memory limiter allows up to max hits per window", () => {
  const key = `t:${Math.random()}`;
  for (let i = 0; i < 3; i++) assert.ok(memoryRateLimit(key, 3, 60_000));
  assert.ok(!memoryRateLimit(key, 3, 60_000));
});

test("memory limiter frees slots after the window passes", async () => {
  const key = `t:${Math.random()}`;
  assert.ok(memoryRateLimit(key, 1, 50));
  assert.ok(!memoryRateLimit(key, 1, 50));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(memoryRateLimit(key, 1, 50));
});

test("rateLimit falls back to memory without REDIS_URL", async () => {
  const key = `t:${Math.random()}`;
  assert.equal(await rateLimit(key, 1, 60_000), true);
  assert.equal(await rateLimit(key, 1, 60_000), false);
});
