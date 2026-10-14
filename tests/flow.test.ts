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

    assert.equal((await verifyReq(s.shareCode, s.otp)).status, 404, "no counter key");
    const other = await newShop();
    assert.equal((await verifyReq(s.shareCode, s.otp, other.deviceKey)).status, 404, "wrong counter");

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
    assert.equal((await verifyReq(s.shareCode, s.otp)).status, 410);
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
    assert.equal((await verifyReq(s.shareCode, wrong)).status, 423);
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

  test("unknown shop code is rejected at upload", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const form = new FormData();
    form.append("file", new File([PDF], "x.pdf"));
    form.append("shopCode", "ZZZZZZ");
    assert.equal((await upload(req("/api/upload", { method: "POST", body: form }))).status, 400);
  });
});
