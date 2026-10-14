/**
 * Shop-side editing: consent, image-edit submission, citizen review, Word
 * conversion/editing through a fake ONLYOFFICE Document Server. Runs the real
 * route handlers against local MongoDB (database "safeprint_test_edit");
 * skipped when Mongo isn't reachable.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const JWT_SECRET = "test-onlyoffice-secret";
process.env.MONGODB_URI = (process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/safeprint_test").replace(
  /\/[^/?]*(\?|$)/,
  "/safeprint_test_edit$1"
);
process.env.LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "safeprint-edit-test-"));
process.env.ONLYOFFICE_JWT_SECRET = JWT_SECRET;
delete process.env.SAFEPRINT_AUTO_APPROVE;
delete process.env.REDIS_URL;

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const CONVERTED_PDF = Buffer.from("%PDF-1.4\n% converted by fake document server\n%%EOF\n");
// Not a real .docx — just enough for the sniffer (ZIP magic + main part name).
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....word/document.xml....original")]);
const EDITED_DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....word/document.xml....edited")]);
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const B = "http://test.local";

let ipCounter = 0;
function req(pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}, base = B): Request {
  return new Request(base + pathname, {
    ...init,
    headers: { "x-forwarded-for": `10.1.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`, ...init.headers },
  });
}
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", ...headers },
});
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const blobExists = (key: string) => fs.existsSync(path.join(process.env.LOCAL_STORE_DIR!, key));

/* eslint-disable @typescript-eslint/no-explicit-any */
let mongoose: any, Session: any, AuditLog: any, config: any, oo: any;
let upload: any, verify: any, approve: any, render: any, printAttempt: any, status: any, sessionClose: any;
let editRequest: any, editDecision: any, editStatus: any, editCancel: any, editPages: any, editPreview: any, editReview: any;
let ooFile: any, ooCallback: any;
let mongoUp = false;

// Fake Document Server: ConvertService fetches the source (as the real one
// does, with its JWT) and returns a URL to a "converted" PDF.
const fetchedSources: Buffer[] = [];
const dsServer = http.createServer(async (rq, rs) => {
  const chunks: Buffer[] = [];
  for await (const c of rq) chunks.push(c as Buffer);
  if (rq.url === "/ConvertService.ashx") {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const payload = oo.verifyJwt(body.token, JWT_SECRET);
    if (!payload) return rs.writeHead(403).end();
    const src = await fetch(payload.url, { headers: { Authorization: `Bearer ${oo.signJwt({ payload: { url: payload.url } })}` } });
    if (!src.ok) return rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: -4 }));
    fetchedSources.push(Buffer.from(await src.arrayBuffer()));
    rs.writeHead(200, { "Content-Type": "application/json" });
    return rs.end(JSON.stringify({ endConvert: true, percent: 100, fileUrl: `${dsBase}/cache/converted.pdf` }));
  }
  if (rq.url === "/cache/converted.pdf") return rs.writeHead(200).end(CONVERTED_PDF);
  if (rq.url === "/cache/edited.docx") return rs.writeHead(200).end(EDITED_DOCX);
  rs.writeHead(404).end();
});
// Bridges the Document Server's server-to-server fetches into the app's route handler.
const appBridge = http.createServer(async (rq, rs) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rq.headers)) if (typeof v === "string") headers[k] = v;
  const r: Response = await ooFile(new Request(`${appBase}${rq.url}`, { headers }));
  rs.writeHead(r.status);
  rs.end(Buffer.from(await r.arrayBuffer()));
});
let dsBase = "";
let appBase = "";

before(async () => {
  dsBase = `http://127.0.0.1:${await listen(dsServer)}`;
  appBase = `http://127.0.0.1:${await listen(appBridge)}`;
  process.env.ONLYOFFICE_URL = dsBase;
  process.env.SAFEPRINT_INTERNAL_URL = appBase;

  mongoose = (await import("mongoose")).default;
  oo = await import("@/lib/onlyoffice");
  try {
    await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 1500 });
    mongoUp = true;
  } catch {
    return;
  }
  await mongoose.connection.db.dropDatabase();
  ({ Session } = await import("@/models/Session"));
  ({ AuditLog } = await import("@/models/AuditLog"));
  ({ config } = await import("@/lib/config"));
  ({ POST: upload } = await import("@/app/api/upload/route"));
  ({ POST: verify } = await import("@/app/api/verify-otp/route"));
  ({ POST: approve } = await import("@/app/api/approve/route"));
  ({ GET: render } = await import("@/app/api/render/route"));
  ({ POST: printAttempt } = await import("@/app/api/print-attempt/route"));
  ({ GET: status } = await import("@/app/api/status/route"));
  ({ POST: sessionClose } = await import("@/app/api/session-close/route"));
  ({ POST: editRequest } = await import("@/app/api/edit/request/route"));
  ({ POST: editDecision } = await import("@/app/api/edit/decision/route"));
  ({ GET: editStatus } = await import("@/app/api/edit/status/route"));
  ({ POST: editCancel } = await import("@/app/api/edit/cancel/route"));
  ({ POST: editPages } = await import("@/app/api/edit/pages/route"));
  ({ GET: editPreview } = await import("@/app/api/edit/preview/route"));
  ({ POST: editReview } = await import("@/app/api/edit/review/route"));
  ({ GET: ooFile } = await import("@/app/api/onlyoffice/file/route"));
  ({ POST: ooCallback } = await import("@/app/api/onlyoffice/callback/route"));
});

after(async () => {
  dsServer.close();
  appBridge.close();
  if (mongoUp) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
  fs.rmSync(process.env.LOCAL_STORE_DIR!, { recursive: true, force: true });
});

/** Upload → OTP → citizen Allow. Returns the citizen's owner token and the shop's viewer token. */
async function openSession(file: Buffer = PDF, name = "affidavit.pdf") {
  const bytes = new Uint8Array(file);
  const form = new FormData();
  form.append("file", new File([bytes], name));
  const up = await upload(req("/api/upload", { method: "POST", body: form }));
  assert.equal(up.status, 200, await up.clone().text());
  const s = await up.json();
  const v = await (await verify(req("/api/verify-otp", json({ shareCode: s.shareCode, otp: s.otp })))).json();
  const a = await approve(req("/api/approve", json({ decision: "allow" }, bearer(s.ownerToken))));
  assert.equal((await a.json()).status, "verified");
  return { ...s, owner: s.ownerToken as string, viewer: v.viewerToken as string };
}

const shop = (s: { viewer: string }) => bearer(s.viewer);
const citizen = (s: { owner: string }) => bearer(s.owner);
const ownerState = async (s: { owner: string }) => (await status(req("/api/status", { headers: citizen(s) }))).json();
const doc = (s: { shareCode: string }) => Session.findOne({ shareCode: s.shareCode });

async function allowImageEdit(s: { viewer: string; owner: string }) {
  const r = await editRequest(req("/api/edit/request", json({ kind: "image" }, shop(s))));
  assert.equal(r.status, 200, await r.clone().text());
  const d = await editDecision(req("/api/edit/decision", json({ decision: "allow" }, citizen(s))));
  assert.equal((await d.json()).editStatus, "editing");
}

function pagesForm(n = 1) {
  const form = new FormData();
  for (let i = 0; i < n; i++) form.append("page", new File([PNG_1PX], `p${i}.png`, { type: "image/png" }));
  form.append("sizes", JSON.stringify(Array.from({ length: n }, () => [595, 842])));
  form.append("tools", JSON.stringify(["crop", "whiteout", "text"]));
  return form;
}

describe("shop-side editing", () => {
  test("image edit: consent → submit → citizen approves → new version prints", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();
    const before = await doc(s);

    const r = await editRequest(req("/api/edit/request", json({ kind: "image" }, shop(s))));
    assert.equal((await r.json()).editStatus, "requested");
    const st = await ownerState(s);
    assert.equal(st.editStatus, "requested");
    assert.ok(st.editRequestExpiresAt);

    // Nothing is editable, renderable or printable until the citizen allows and reviews.
    assert.equal((await editPages(req("/api/edit/pages", { method: "POST", body: pagesForm(), headers: shop(s) }))).status, 409);
    assert.equal((await render(req("/api/render", { headers: shop(s) }))).status, 409);
    assert.equal((await printAttempt(req("/api/print-attempt", { method: "POST", headers: shop(s) }))).status, 409);

    await editDecision(req("/api/edit/decision", json({ decision: "allow" }, citizen(s))));
    const extended = await doc(s);
    assert.ok(extended.expiresAt.getTime() > before.expiresAt.getTime(), "TTL extended once for editing");

    const p = await editPages(req("/api/edit/pages", { method: "POST", body: pagesForm(2), headers: shop(s) }));
    assert.equal(p.status, 200, await p.clone().text());
    assert.equal((await ownerState(s)).editStatus, "pending_review");
    assert.equal((await render(req("/api/render", { headers: shop(s) }))).status, 409, "no render while under review");

    const pv = await editPreview(req("/api/edit/preview", { headers: citizen(s) }));
    assert.equal(pv.status, 200);
    const edited = Buffer.from(await pv.arrayBuffer());
    assert.equal(edited.subarray(0, 4).toString("latin1"), "%PDF");
    assert.equal((await editPreview(req("/api/edit/preview", { headers: shop(s) }))).status, 404, "shop can't use the preview");

    const rv = await (await editReview(req("/api/edit/review", json({ decision: "approve" }, citizen(s))))).json();
    assert.equal(rv.editStatus, "none");
    assert.equal(rv.editRoundsLeft, 2);
    assert.equal(rv.editLastOutcome, "approved");

    const rendered = await render(req("/api/render", { headers: shop(s) }));
    assert.equal(rendered.status, 200);
    assert.deepEqual(Buffer.from(await rendered.arrayBuffer()), edited, "the approved edit is the print copy");
    assert.equal(blobExists(before.fileKey), false, "previous version shredded");

    const events = (await AuditLog.find({ sessionId: before._id }).sort({ at: 1 })).map((e: any) => e.event);
    for (const e of ["edit_requested", "edit_granted", "edit_submitted", "edit_approved"]) assert.ok(events.includes(e), e);
    const submitted = await AuditLog.findOne({ sessionId: before._id, event: "edit_submitted" });
    assert.deepEqual(submitted.meta.tools, ["crop", "whiteout", "text"]);
  });

  test("rejected edit is shredded and the original stays", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();
    await allowImageEdit(s);
    await editPages(req("/api/edit/pages", { method: "POST", body: pagesForm(), headers: shop(s) }));
    const editedKey = (await doc(s)).edited.key;
    assert.ok(blobExists(editedKey));

    const rv = await (await editReview(req("/api/edit/review", json({ decision: "reject" }, citizen(s))))).json();
    assert.equal(rv.editStatus, "none");
    assert.equal(rv.editLastOutcome, "rejected");
    assert.equal(blobExists(editedKey), false);
    const r = await render(req("/api/render", { headers: shop(s) }));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  });

  test("deny, timeout and cancel each end the round; rounds are capped", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();

    await editRequest(req("/api/edit/request", json({ kind: "image" }, shop(s))));
    assert.equal((await (await editDecision(req("/api/edit/decision", json({ decision: "deny" }, citizen(s))))).json()).editStatus, "none");

    await editRequest(req("/api/edit/request", json({ kind: "image" }, shop(s))));
    await Session.updateOne({ shareCode: s.shareCode }, { editRequestedAt: new Date(Date.now() - 10 * 60 * 1000) });
    assert.equal((await (await editStatus(req("/api/edit/status", { headers: shop(s) }))).json()).editStatus, "none", "timed out");

    await allowImageEdit(s);
    assert.equal((await editCancel(req("/api/edit/cancel", { method: "POST", headers: shop(s) }))).status, 200);

    const capped = await editRequest(req("/api/edit/request", json({ kind: "image" }, shop(s))));
    assert.equal(capped.status, 403);
    assert.equal((await capped.json()).editRoundsLeft, 0);
    assert.equal((await render(req("/api/render", { headers: shop(s) }))).status, 200, "original still prints");

    const events = (await AuditLog.find({ sessionId: (await doc(s))._id })).map((e: any) => e.event);
    for (const e of ["edit_denied", "edit_timeout", "edit_cancelled"]) assert.ok(events.includes(e), e);
  });

  test("bad page uploads are refused", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();
    await allowImageEdit(s);

    const notImage = new FormData();
    notImage.append("page", new File([PDF], "p.pdf"));
    notImage.append("sizes", "[[595,842]]");
    assert.equal((await editPages(req("/api/edit/pages", { method: "POST", body: notImage, headers: shop(s) }))).status, 415);

    const badSize = pagesForm();
    badSize.set("sizes", "[[1,1]]");
    assert.equal((await editPages(req("/api/edit/pages", { method: "POST", body: badSize, headers: shop(s) }))).status, 400);
    assert.equal((await doc(s)).editStatus, "editing", "still editable after a bad upload");
  });

  test("closing the session shreds edited versions too", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();
    await allowImageEdit(s);
    await editPages(req("/api/edit/pages", { method: "POST", body: pagesForm(), headers: shop(s) }));
    const pending = await doc(s);

    await sessionClose(req("/api/session-close", { method: "POST", body: JSON.stringify({ viewerToken: s.viewer }) }));
    const closed = await doc(s);
    assert.equal(closed.status, "closed");
    assert.equal(closed.edited, null);
    assert.equal(blobExists(pending.edited.key), false);
    assert.equal(blobExists(pending.fileKey), false);
  });

  test("Word: upload converts via the Document Server, edit round-trips through the callback", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession(DOCX, "rent-agreement.docx");
    assert.equal(s.convertedFrom, "docx");
    assert.deepEqual(fetchedSources.at(-1), DOCX, "Document Server fetched the original through the sealed URL");

    const original = await doc(s);
    assert.equal(original.mimeType, "application/pdf");
    assert.equal(original.sourceExt, "docx");
    const r = await render(req("/api/render", { headers: shop(s) }));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), CONVERTED_PDF);

    await editRequest(req("/api/edit/request", json({ kind: "word" }, shop(s))));
    await editDecision(req("/api/edit/decision", json({ decision: "allow" }, citizen(s))));
    const st = await (await editStatus(req("/api/edit/status", { headers: shop(s) }))).json();
    assert.equal(st.editStatus, "editing");
    const cfg = st.editor;
    assert.equal(cfg.document.permissions.download, false);
    assert.equal(cfg.document.permissions.print, false);
    assert.equal(cfg.document.permissions.copy, false);
    assert.ok(oo.verifyJwt(cfg.token, JWT_SECRET), "editor config is signed");

    // The source URL works only for the Document Server (its JWT), not a browser.
    assert.equal((await fetch(cfg.document.url)).status, 403);
    const src = await fetch(cfg.document.url, { headers: { Authorization: `Bearer ${oo.signJwt({ payload: {} })}` } });
    assert.deepEqual(Buffer.from(await src.arrayBuffer()), DOCX);

    const callbackPath = cfg.editorConfig.callbackUrl.slice(appBase.length);
    const cb = (body: object, token = true) =>
      ooCallback(req(callbackPath, json(token ? { ...body, token: oo.signJwt(body) } : body)));

    assert.equal((await (await cb({ status: 6, url: `${dsBase}/cache/edited.docx` }, false)).json()).error, 1, "unsigned callback refused");
    assert.equal((await (await cb({ status: 6, url: "http://evil.example/x.docx", filetype: "docx" })).json()).error, 1, "foreign URL refused");
    assert.equal((await doc(s)).editStatus, "editing");

    assert.equal((await (await cb({ status: 6, url: `${dsBase}/cache/edited.docx`, filetype: "docx" })).json()).error, 0);
    assert.equal((await ownerState(s)).editStatus, "pending_review");
    assert.equal((await (await cb({ status: 2, url: `${dsBase}/cache/edited.docx`, filetype: "docx" })).json()).error, 0, "late close callback is a no-op");

    await editReview(req("/api/edit/review", json({ decision: "approve" }, citizen(s))));
    const approved = await doc(s);
    assert.notEqual(approved.source.key, original.source.key, "edited .docx is the new Word source");
    assert.equal(blobExists(original.source.key), false);
    const { readBlob } = await import("@/lib/blobs");
    assert.deepEqual(await readBlob(approved.source), EDITED_DOCX);
  });

  test("print attempt records the layout used, validated", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession();
    const layout = [
      { rotate: 90, offsetXmm: -5, offsetYmm: 0, scalePct: 100, fit: "fit", paper: "A4", include: true, grayscale: false },
      { rotate: 0, offsetXmm: 999, offsetYmm: 0, scalePct: 100, fit: "fit", paper: "A4", include: false, grayscale: true },
    ];
    const r = await printAttempt(req("/api/print-attempt", json({ layout }, shop(s))));
    assert.equal(r.status, 200);
    const log = await AuditLog.findOne({ sessionId: (await doc(s))._id, event: "print_attempt" });
    assert.deepEqual(log.meta.layout.skipped, [2]);
    assert.equal(log.meta.layout.changed.p1.rotate, 90);
    assert.equal(log.meta.layout.changed.p2.offsetXmm, 40, "clamped");
    // A print attempt without a body still works and logs no layout.
    const plain = await printAttempt(req("/api/print-attempt", { method: "POST", headers: shop(s) }));
    assert.equal(plain.status, 200);
  });

  test("Word upload is refused cleanly when no Document Server is configured", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const saved = config.onlyofficeUrl;
    config.onlyofficeUrl = "";
    try {
      const form = new FormData();
      form.append("file", new File([DOCX], "x.docx"));
      const res = await upload(req("/api/upload", { method: "POST", body: form }));
      assert.equal(res.status, 415);
      assert.match((await res.json()).error, /PDF/);
    } finally {
      config.onlyofficeUrl = saved;
    }
  });
});
