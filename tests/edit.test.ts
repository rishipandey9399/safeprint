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
// Small limits so the busy path is reachable: 1 running + 1 waiting.
process.env.WORD_CONVERSION_CONCURRENCY = "1";
process.env.WORD_CONVERSION_QUEUE = "1";
process.env.WORD_CONVERSION_WAIT_MS = "10000";
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
const JPEG_1PX = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);
/** A JPEG header claiming 20000×20000 px — tiny file, would be 1.6 GB decoded. */
const JPEG_HUGE = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);
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
let convertDelayMs = 0;
// CommandService calls the app made, and the "forgotten" copies it holds.
const dsCommands: Array<Record<string, unknown>> = [];
let forgotten: string[] = [];
const dsServer = http.createServer(async (rq, rs) => {
  const chunks: Buffer[] = [];
  for await (const c of rq) chunks.push(c as Buffer);
  if (rq.url === "/ConvertService.ashx") {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const payload = oo.verifyJwt(body.token, JWT_SECRET);
    if (!payload) return rs.writeHead(403).end();
    if (convertDelayMs) await new Promise((r) => setTimeout(r, convertDelayMs));
    const src = await fetch(payload.url, { headers: { Authorization: `Bearer ${oo.signJwt({ payload: { url: payload.url } })}` } });
    if (!src.ok) return rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: -4 }));
    fetchedSources.push(Buffer.from(await src.arrayBuffer()));
    rs.writeHead(200, { "Content-Type": "application/json" });
    return rs.end(JSON.stringify({ endConvert: true, percent: 100, fileUrl: `${dsBase}/cache/converted.pdf` }));
  }
  if (rq.url === "/coauthoring/CommandService.ashx") {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const cmd = oo.verifyJwt(body.token, JWT_SECRET);
    if (!cmd) return rs.writeHead(403).end();
    dsCommands.push(cmd);
    const reply = (o: object) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
    if (cmd.c === "getForgottenList") return reply({ error: 0, keys: forgotten });
    if (cmd.c === "deleteForgotten") {
      forgotten = forgotten.filter((k) => k !== cmd.key);
      return reply({ error: 0, key: cmd.key });
    }
    return reply({ error: 0, key: cmd.key });
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
  for (let i = 0; i < n; i++) form.append("page", new File([new Uint8Array(JPEG_1PX)], `p${i}.jpg`, { type: "image/jpeg" }));
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

    const png = new FormData();
    png.append("page", new File([new Uint8Array(PNG_1PX)], "p.png"));
    png.append("sizes", "[[595,842]]");
    assert.equal((await editPages(req("/api/edit/pages", { method: "POST", body: png, headers: shop(s) }))).status, 415, "PNG decodes fully in memory — refused");

    const huge = new FormData();
    huge.append("page", new File([new Uint8Array(JPEG_HUGE)], "p.jpg"));
    huge.append("sizes", "[[595,842]]");
    assert.equal((await editPages(req("/api/edit/pages", { method: "POST", body: huge, headers: shop(s) }))).status, 413, "pixel cap");

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

    // The source URL works only for the Document Server's JWT for that exact URL.
    const as = (token: string) => fetch(cfg.document.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await fetch(cfg.document.url)).status, 403, "no JWT");
    assert.equal((await as(cfg.token)).status, 403, "the editor config token the shop's browser holds");
    assert.equal((await as(oo.signJwt({ payload: {} }))).status, 403, "JWT naming no URL");
    const otherUrl = cfg.document.url.replace(/t=[^&]+/, "t=someOtherReference");
    assert.equal((await as(oo.signJwt({ payload: { url: otherUrl } }))).status, 403, "JWT for another file");
    const src = await as(oo.signJwt({ payload: { url: cfg.document.url } }));
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
    const pageMm = [[210, 297], [210, 297]];
    const r = await printAttempt(req("/api/print-attempt", json({ layout, pageMm }, shop(s))));
    assert.equal(r.status, 200);
    const log = await AuditLog.findOne({ sessionId: (await doc(s))._id, event: "print_attempt" });
    assert.deepEqual(log.meta.layout.skipped, [2]);
    assert.deepEqual(log.meta.layout.offPaper, [1], "rotated A4 page on portrait A4 shifted 5 mm overhangs");
    assert.equal(log.meta.layout.changed.p1.rotate, 90);
    assert.equal(log.meta.layout.changed.p2.offsetXmm, 40, "clamped");
    // A print attempt without a body still works and logs no layout.
    const plain = await printAttempt(req("/api/print-attempt", { method: "POST", headers: shop(s) }));
    assert.equal(plain.status, 200);
  });

  test("Word conversions are limited; overflow gets 503 and leaves nothing stored", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const blobsBefore = fs.readdirSync(process.env.LOCAL_STORE_DIR!).length;
    convertDelayMs = 400;
    try {
      const uploadDocx = () => {
        const form = new FormData();
        form.append("file", new File([new Uint8Array(DOCX)], "x.docx"));
        return upload(req("/api/upload", { method: "POST", body: form }));
      };
      const results = await Promise.all([uploadDocx(), uploadDocx(), uploadDocx(), uploadDocx()]);
      const codes = results.map((r: Response) => r.status).sort();
      assert.deepEqual(codes, [200, 200, 503, 503], "1 converting + 1 waiting; the rest are told to retry");
      const busy = results.find((r: Response) => r.status === 503)!;
      assert.equal(busy.headers.get("retry-after"), "30");
      assert.match((await busy.json()).error, /busy/);
      // Each accepted upload stores its Word source + PDF; refused ones store nothing.
      assert.equal(fs.readdirSync(process.env.LOCAL_STORE_DIR!).length - blobsBefore, 4);
    } finally {
      convertDelayMs = 0;
    }
  });

  test("ending a Word round disconnects the editor and deletes only that session's forgotten copies", async (t) => {
    if (!mongoUp) return t.skip("MongoDB not reachable");
    const s = await openSession(DOCX, "lease.docx");
    const sid = String((await doc(s))._id);
    await editRequest(req("/api/edit/request", json({ kind: "word" }, shop(s))));
    await editDecision(req("/api/edit/decision", json({ decision: "allow" }, citizen(s))));
    forgotten = [`sp${sid}r0`, "spSOMEONEELSEr0", "not-ours"];
    dsCommands.length = 0;

    assert.equal((await editCancel(req("/api/edit/cancel", { method: "POST", headers: shop(s) }))).status, 200);
    // Release is fire-and-forget so it never delays the user; wait for it.
    for (let i = 0; i < 50 && forgotten.includes(`sp${sid}r0`); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(dsCommands.some((c) => c.c === "drop" && c.key === `sp${sid}r0`), "editor disconnected");
    assert.deepEqual(forgotten, ["spSOMEONEELSEr0", "not-ours"], "only this session's copy deleted");

    // The cleanup sweep is the backstop: it removes every SafePrint forgotten copy, nothing else.
    const { sweepExpiredSessions } = await import("@/lib/lifecycle");
    await sweepExpiredSessions();
    assert.deepEqual(forgotten, ["not-ours"]);
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
