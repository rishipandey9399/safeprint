/**
 * End-to-end session flow through the real route handlers against a local
 * MongoDB (database "safeprint_test"). Skipped when Mongo isn't reachable.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/safeprint_test";
process.env.LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "safeprint-test-"));
delete process.env.SAFEPRINT_AUTO_APPROVE;
delete process.env.REDIS_URL;
// Keep the anti-timing floor short in tests (a dedicated test raises it).
process.env.VERIFY_FAIL_FLOOR_MS = "20";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const B = "http://test.local";

// Each request gets its own client IP so per-IP rate limits don't interfere.
let ipCounter = 0;
function req(pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(B + pathname, {
    ...init,
    headers: { "x-forwarded-for": `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`, ...init.headers },
  });
}
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", ...headers },
});
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/* eslint-disable @typescript-eslint/no-explicit-any */
let mongoose: any, Session: any, upload: any, verify: any, approve: any, approvalStatus: any;
let regenerate: any, status: any, render: any, register: any, jobs: any;
let mongoUp = false;

before(async () => {
  mongoose = (await import("mongoose")).default;
  try {
    await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 1500 });
    mongoUp = true;
  } catch {
    return;
  }
  await mongoose.connection.db.dropDatabase();
  ({ Session } = await import("@/models/Session"));
  ({ POST: upload } = await import("@/app/api/upload/route"));
  ({ POST: verify } = await import("@/app/api/verify-otp/route"));
  ({ POST: approve } = await import("@/app/api/approve/route"));
  ({ GET: approvalStatus } = await import("@/app/api/approval-status/route"));
  ({ POST: regenerate } = await import("@/app/api/regenerate-otp/route"));
  ({ GET: status } = await import("@/app/api/status/route"));
  ({ GET: render } = await import("@/app/api/render/route"));
  ({ POST: register } = await import("@/app/api/shops/register/route"));
  ({ GET: jobs } = await import("@/app/api/shops/jobs/route"));
});

after(async () => {
  if (mongoUp) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
  fs.rmSync(process.env.LOCAL_STORE_DIR!, { recursive: true, force: true });
});

async function newShop() {
  const res = await register(req("/api/shops/register", json({ name: "Test Xerox", area: "Andheri" })));
  assert.equal(res.status, 200);
  return res.json() as Promise<{ shopCode: string; deviceKey: string }>;
}

async function newUpload(shopCode?: string) {
  const form = new FormData();
  form.append("file", new File([PDF], "aadhaar.pdf", { type: "application/pdf" }));
  if (shopCode) form.append("shopCode", shopCode);
  const res = await upload(req("/api/upload", { method: "POST", body: form }));
  assert.equal(res.status, 200, await res.clone().text());
  return res.json() as Promise<{ shareCode: string; otp: string; ownerToken: string; shopName: string | null }>;
}

const verifyReq = (shareCode: string, otp: string, shopKey?: string) =>
  verify(req("/api/verify-otp", json({ shareCode, otp }, shopKey ? { "X-SafePrint-Shop-Key": shopKey } : {})));

describe("SafePrint session flow", () => {
  test("paired session: key required, approval required, then renders", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const shop = await newShop();
    const s = await newUpload(shop.shopCode);
    assert.equal(s.shopName, "Test Xerox, Andheri");

    const queue = await (await jobs(req("/api/shops/jobs", { headers: { "X-SafePrint-Shop-Key": shop.deviceKey } }))).json();
    assert.deepEqual(queue.jobs.map((j: any) => j.shareCode), [s.shareCode]);

    assert.equal((await verifyReq(s.shareCode, s.otp)).status, 401, "no counter key");
    const other = await newShop();
    assert.equal((await verifyReq(s.shareCode, s.otp, other.deviceKey)).status, 401, "wrong counter");

    const v = await verifyReq(s.shareCode, s.otp, shop.deviceKey);
    assert.equal(v.status, 200);
    const vd = await v.json();
    assert.equal(vd.pendingApproval, true);
    assert.equal(vd.fileName, undefined, "no document details before approval");

    assert.equal((await render(req("/api/render", { headers: bearer(vd.viewerToken) }))).status, 403);
    assert.equal((await (await approvalStatus(req("/api/approval-status", { headers: bearer(vd.viewerToken) }))).json()).state, "pending");

    const a = await approve(req("/api/approve", json({ decision: "allow" }, bearer(s.ownerToken))));
    assert.equal((await a.json()).status, "verified");
    const as = await (await approvalStatus(req("/api/approval-status", { headers: bearer(vd.viewerToken) }))).json();
    assert.equal(as.state, "approved");
    assert.equal(as.fileName, "aadhaar.pdf");

    const r = await render(req("/api/render", { headers: bearer(vd.viewerToken) }));
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  });

  test("deny voids the viewer token and returns to awaiting_otp", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const vd = await (await verifyReq(s.shareCode, s.otp)).json();
    await approve(req("/api/approve", json({ decision: "deny" }, bearer(s.ownerToken))));
    assert.equal((await (await approvalStatus(req("/api/approval-status", { headers: bearer(vd.viewerToken) }))).json()).state, "denied");
    assert.equal((await (await status(req("/api/status", { headers: bearer(s.ownerToken) }))).json()).status, "awaiting_otp");
  });

  test("unanswered approval times out", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const vd = await (await verifyReq(s.shareCode, s.otp)).json();
    await Session.updateOne({ shareCode: s.shareCode }, { approvalRequestedAt: new Date(Date.now() - 10 * 60 * 1000) });
    assert.equal((await (await approvalStatus(req("/api/approval-status", { headers: bearer(vd.viewerToken) }))).json()).state, "denied");
    assert.equal((await (await status(req("/api/status", { headers: bearer(s.ownerToken) }))).json()).status, "awaiting_otp");
  });

  test("expired OTP is refused without counting an attempt", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    await Session.updateOne({ shareCode: s.shareCode }, { otpExpiresAt: new Date(Date.now() - 1000) });
    // Without the paired counter key, an expired OTP looks like any other failure.
    assert.equal((await verifyReq(s.shareCode, s.otp)).status, 401);
    const st = await (await status(req("/api/status", { headers: bearer(s.ownerToken) }))).json();
    assert.equal(st.otpAttemptsLeft, 5);
  });

  test("regenerate invalidates the old OTP and is capped", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const r = await (await regenerate(req("/api/regenerate-otp", { method: "POST", headers: bearer(s.ownerToken) }))).json();
    assert.match(r.otp, /^\d{6}$/);
    if (r.otp !== s.otp) assert.equal((await verifyReq(s.shareCode, s.otp)).status, 401, "old OTP rejected");
    for (let i = 0; i < 4; i++) {
      await regenerate(req("/api/regenerate-otp", { method: "POST", headers: bearer(s.ownerToken) }));
    }
    const capped = await regenerate(req("/api/regenerate-otp", { method: "POST", headers: bearer(s.ownerToken) }));
    assert.equal(capped.status, 429);
  });

  test("5 wrong OTPs lock the session and delete the file", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const wrong = s.otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) assert.equal((await verifyReq(s.shareCode, wrong)).status, 401);
    assert.equal((await verifyReq(s.shareCode, wrong)).status, 401, "lockout is not announced to strangers");
    const doc = await Session.findOne({ shareCode: s.shareCode });
    assert.equal(doc.status, "locked");
    assert.equal(doc.wrappedKey, "", "keys crypto-shredded");
    assert.equal(fs.existsSync(path.join(process.env.LOCAL_STORE_DIR!, doc.fileKey)), false);
  });

  test("owner token is accepted only in the Authorization header", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    assert.equal((await status(req(`/api/status?ownerToken=${s.ownerToken}`))).status, 404);
    assert.equal((await status(req("/api/status", { headers: bearer(s.ownerToken) }))).status, 200);
  });

  test("verify-otp gives strangers no oracle for which share codes exist", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const wrong = s.otp === "000000" ? "111111" : "000000";
    const unknown = await verifyReq("ZZZZZZ", wrong);
    const real = await verifyReq(s.shareCode, wrong);
    assert.equal(unknown.status, real.status);
    assert.deepEqual(await unknown.json(), await real.json());
  });

  test("the paired counter still gets specific messages for its own sessions", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const shop = await newShop();
    const s = await newUpload(shop.shopCode);
    const wrong = s.otp === "000000" ? "111111" : "000000";
    const r = await verifyReq(s.shareCode, wrong, shop.deviceKey);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /4 attempt\(s\) left/);
    await Session.updateOne({ shareCode: s.shareCode }, { otpExpiresAt: new Date(Date.now() - 1000) });
    assert.equal((await verifyReq(s.shareCode, s.otp, shop.deviceKey)).status, 410);
  });

  test("checks against one share code are capped per minute, whatever the IP", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await newUpload();
    const wrong = s.otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await verifyReq(s.shareCode, wrong); // each from a new IP
    // 5th check of this minute is still allowed, the 6th is braked.
    await verifyReq("ABCDEF", wrong);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await verifyReq("KQ2X9M", wrong)).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  });

  test("a service-wide miss budget brakes scanning, but never registered counters", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const { config } = await import("@/lib/config");
    const saved = config.verifyGlobalMissesPerMinute;
    config.verifyGlobalMissesPerMinute = 3;
    // Earlier tests' misses share the in-memory window; start this one clean.
    (global as unknown as { _rateBuckets: Map<string, number[]> })._rateBuckets.delete("verify-miss:global");
    try {
      const shop = await newShop();
      const paired = await newUpload(shop.shopCode);
      const codes = ["MMMMM2", "MMMMM3", "MMMMM4", "MMMMM5"];
      const statuses = [];
      for (const c of codes) statuses.push((await verifyReq(c, "123456")).status);
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.equal(statuses[3], 429, "scanner braked");
      const v = await verifyReq(paired.shareCode, paired.otp, shop.deviceKey);
      assert.equal(v.status, 200, "a registered counter is unaffected");
    } finally {
      config.verifyGlobalMissesPerMinute = saved;
    }
  });

  test("ended sessions keep no file name, expire by TTL, and audit logs carry no names", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const { AuditLog } = await import("@/models/AuditLog");
    const s = await newUpload();
    const wrong = s.otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verifyReq(s.shareCode, wrong); // lock -> finalize
    const doc = await Session.findOne({ shareCode: s.shareCode });
    assert.equal(doc.status, "locked");
    assert.equal(doc.fileName, "[deleted]");
    const days = (doc.purgeAt.getTime() - Date.now()) / 86400_000;
    assert.ok(days > 29 && days <= 30, `purgeAt ~30 days out (${days})`);

    const up = await AuditLog.findOne({ sessionId: doc._id, event: "upload" });
    assert.equal(up!.meta.fileName, undefined);
    assert.equal(up!.meta.ext, "pdf");

    await Session.init();
    await AuditLog.init();
    const ttl = (idx: Array<{ key: Record<string, number>; expireAfterSeconds?: number }>, field: string) =>
      idx.find((i) => i.key[field] === 1 && i.expireAfterSeconds !== undefined)?.expireAfterSeconds;
    assert.equal(ttl(await Session.collection.indexes() as never, "purgeAt"), 0);
    assert.equal(ttl(await AuditLog.collection.indexes() as never, "at"), 90 * 86400);
  });

  test("a self-registered counter key earns no scanning exemption", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const { config } = await import("@/lib/config");
    const saved = config.verifyPerCounterMissesPerMinute;
    config.verifyPerCounterMissesPerMinute = 3;
    try {
      const scanner = await newShop(); // anyone can register one
      const statuses = [];
      for (const c of ["QQQQQ2", "QQQQQ3", "QQQQQ4", "QQQQQ5"]) {
        statuses.push((await verifyReq(c, "123456", scanner.deviceKey)).status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429]);
    } finally {
      config.verifyPerCounterMissesPerMinute = saved;
    }
  });

  test("a stranger hammering a share code can't lock its own counter out", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const shop = await newShop();
    const s = await newUpload(shop.shopCode);
    const junk = [];
    for (let i = 0; i < 6; i++) junk.push((await verifyReq(s.shareCode, "000000")).status);
    assert.equal(junk.at(-1), 429, "the stranger is braked");
    const v = await verifyReq(s.shareCode, s.otp, shop.deviceKey);
    assert.equal(v.status, 200, "the paired counter still opens it");
  });

  test("unknown and real codes take the same time to fail", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const { config } = await import("@/lib/config");
    const saved = config.verifyFailFloorMs;
    config.verifyFailFloorMs = 150;
    try {
      const s = await newUpload();
      const wrong = s.otp === "000000" ? "111111" : "000000";
      const time = async (code: string) => {
        const t0 = performance.now();
        const r = await verifyReq(code, wrong);
        assert.equal(r.status, 401);
        return performance.now() - t0;
      };
      for (const ms of [await time("WWWWW2"), await time(s.shareCode)]) {
        assert.ok(ms >= 145 && ms < 400, `failure took ${ms.toFixed(0)}ms, expected the ~150ms floor`);
      }
    } finally {
      config.verifyFailFloorMs = saved;
    }
  });

  test("uploads are limited per device as well as per IP", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const { config } = await import("@/lib/config");
    const saved = config.limits.uploadPerDeviceHour;
    config.limits.uploadPerDeviceHour = 2;
    try {
      const deviceA = crypto.randomUUID();
      const send = (device: string) => {
        const form = new FormData();
        form.append("file", new File([PDF], "a.pdf"));
        return upload(req("/api/upload", { method: "POST", body: form, headers: { "X-SafePrint-Device": device } }));
      };
      const codes = [(await send(deviceA)).status, (await send(deviceA)).status, (await send(deviceA)).status];
      assert.deepEqual(codes, [200, 200, 429]);
      assert.equal((await send(crypto.randomUUID())).status, 200, "another phone is unaffected");
    } finally {
      config.limits.uploadPerDeviceHour = saved;
    }
  });

  test("unknown shop code is rejected at upload", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const form = new FormData();
    form.append("file", new File([PDF], "x.pdf"));
    form.append("shopCode", "ZZZZZZ");
    assert.equal((await upload(req("/api/upload", { method: "POST", body: form }))).status, 400);
  });
});
