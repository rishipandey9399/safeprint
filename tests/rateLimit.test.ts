import { test } from "node:test";
import assert from "node:assert/strict";
import { getClientIp, memoryRateLimit, rateLimit } from "@/lib/rateLimit";
import { config } from "@/lib/config";

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

test("client IP is the entry our proxy appended, never a client-supplied one", () => {
  const req = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
  const saved = config.trustProxyHops;
  try {
    config.trustProxyHops = 1;
    assert.equal(getClientIp(req("198.51.100.9")), "198.51.100.9");
    // Client pre-fills a fake address; nginx appends the real one.
    assert.equal(getClientIp(req("6.6.6.6, 198.51.100.9")), "198.51.100.9");
    config.trustProxyHops = 2; // client -> CDN -> load balancer
    assert.equal(getClientIp(req("6.6.6.6, 198.51.100.9, 10.0.0.2")), "198.51.100.9");
    config.trustProxyHops = 0; // no proxy: the header is ignored
    assert.equal(getClientIp(req("6.6.6.6")), "direct");
    assert.equal(getClientIp(req()), "direct");
  } finally {
    config.trustProxyHops = saved;
  }
});
