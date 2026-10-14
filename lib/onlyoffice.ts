import crypto from "crypto";
import { config, wordEditingEnabled } from "./config";
import type { ISession, StoredBlob } from "@/models/Session";

/**
 * ONLYOFFICE Document Server integration: Word → PDF conversion on upload and
 * the embedded Word editor. The Document Server is self-hosted; it fetches the
 * source file from /api/onlyoffice/file (server-to-server, sealed short-lived
 * reference) and posts edits back to /api/onlyoffice/callback. The shop's
 * browser never gets a file URL — download, print and copy are switched off in
 * the editor permissions, and printing only ever happens through the locked
 * viewer after the citizen approves the edited version.
 */

// ---------------------------------------------------------------------------
// HS256 JWT (the Document Server's request-signing scheme)
// ---------------------------------------------------------------------------

const b64url = (buf: Buffer) => buf.toString("base64url");

export function signJwt(payload: object, secret = config.onlyofficeJwtSecret, ttlSeconds = 300): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret = config.onlyofficeJwtSecret): Record<string, unknown> | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (h.alg !== "HS256") return null;
    const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    // Every token must expire: ours always carry exp, and so do the Document Server's.
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Reads the Document Server's JWT from the Authorization header or the JSON body's `token`. */
export function readDocServerJwt(req: Request, body?: Record<string, unknown>): Record<string, unknown> | null {
  const auth = req.headers.get("authorization") ?? "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const bodyToken = typeof body?.token === "string" ? body.token : "";
  const decoded = verifyJwt(bodyToken || headerToken);
  if (!decoded || isEditorConfigToken(decoded)) return null;
  // Header tokens wrap the request body under `payload`; body tokens are the body.
  const inner = decoded.payload;
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : decoded;
}

/**
 * The editor config we sign is handed to the shop's browser, so a token that
 * looks like one must never pass as a Document Server request.
 */
function isEditorConfigToken(decoded: Record<string, unknown>): boolean {
  return "document" in decoded || "editorConfig" in decoded;
}

/**
 * Authorizes a Document Server file download. The Document Server signs
 * `{ payload: { url } }` with the exact URL it is fetching, so the token must
 * name this very sealed reference — any other token signed with the shared
 * secret (e.g. the editor config the shop's browser holds) is refused.
 */
export function authorizeFileFetch(req: Request): string | null {
  const t = new URL(req.url).searchParams.get("t");
  if (!t) return null;
  const auth = req.headers.get("authorization") ?? "";
  const decoded = verifyJwt(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!decoded || isEditorConfigToken(decoded)) return null;
  const inner = decoded.payload as { url?: unknown } | undefined;
  if (typeof inner?.url !== "string") return null;
  try {
    const signed = new URL(inner.url);
    if (signed.pathname !== "/api/onlyoffice/file" || signed.searchParams.get("t") !== t) return null;
  } catch {
    return null;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Sealed references — opaque, short-lived, tamper-proof pointers that let the
// Document Server fetch a blob (or call back about a session) with no DB-side
// token table, and that work across app instances.
// ---------------------------------------------------------------------------

const sealKey = crypto.createHash("sha256").update(config.masterKey).update("safeprint/onlyoffice-ref/v1").digest();

export function sealRef(data: object, ttlSeconds = 300): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey, iv);
  const plain = Buffer.from(JSON.stringify({ d: data, exp: Date.now() + ttlSeconds * 1000 }));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

export function openRef<T>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const { d, exp } = JSON.parse(plain.toString("utf8"));
    if (typeof exp !== "number" || exp < Date.now()) return null;
    return d as T;
  } catch {
    return null;
  }
}

export interface FileRef {
  blob: StoredBlob;
  ext: string;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Base URL the Document Server uses to reach this app. */
export function appBaseUrl(req: Request): string {
  return config.internalBaseUrl || new URL(req.url).origin;
}

export function fileUrlFor(base: string, blob: StoredBlob, ext: string, ttlSeconds = 300): string {
  return `${base}/api/onlyoffice/file?t=${sealRef({ blob, ext } satisfies FileRef, ttlSeconds)}`;
}

/** Only ever fetch result files from the configured Document Server (no SSRF via callbacks). */
export function isDocServerUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const ds = new URL(config.onlyofficeUrl);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === ds.host;
  } catch {
    return false;
  }
}

const MAX_RESULT_BYTES = 40 * 1024 * 1024;

export async function downloadFromDocServer(url: string): Promise<Buffer> {
  if (!isDocServerUrl(url)) throw new Error("Refusing to fetch a file from outside the Document Server.");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Document Server file fetch failed (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RESULT_BYTES) throw new Error("Document Server result too large.");
  return buf;
}

// ---------------------------------------------------------------------------
// Conversion + commands
// ---------------------------------------------------------------------------

export class ConversionError extends Error {}
/** Too many conversions are running or waiting; the caller should ask the user to retry. */
export class ConversionBusyError extends ConversionError {}

// In-process limiter: a burst of Word uploads can't pile unbounded work onto
// the Document Server or hold unbounded requests open here. Per app process.
let running = 0;
const waiting: Array<() => void> = [];

async function acquireConversionSlot(): Promise<void> {
  if (running < config.wordConversionConcurrency) {
    running++;
    return;
  }
  if (waiting.length >= config.wordConversionQueue) {
    throw new ConversionBusyError("Too many Word conversions in progress.");
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      running++;
      resolve();
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(grant);
      if (i >= 0) waiting.splice(i, 1);
      reject(new ConversionBusyError("Timed out waiting for a Word conversion slot."));
    }, config.wordConversionWaitMs);
    waiting.push(grant);
  });
}

function releaseConversionSlot(): void {
  running--;
  waiting.shift()?.();
}

/** Converts the document at `sourceUrl` (reachable by the Document Server) to PDF. */
export async function convertToPdf(sourceUrl: string, ext: string, title = "document"): Promise<Buffer> {
  await acquireConversionSlot();
  try {
    return await runConversion(sourceUrl, ext, title);
  } finally {
    releaseConversionSlot();
  }
}

async function runConversion(sourceUrl: string, ext: string, title: string): Promise<Buffer> {
  const payload = {
    async: false,
    filetype: ext,
    outputtype: "pdf",
    key: crypto.randomUUID(),
    title: `${title}.${ext}`,
    url: sourceUrl,
  };
  let res: Response;
  try {
    res = await fetch(`${config.onlyofficeUrl}/ConvertService.ashx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...payload, token: signJwt(payload) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ConversionError(`Document Server unreachable: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: number; endConvert?: boolean; fileUrl?: string };
  if (!res.ok || data.error || !data.endConvert || !data.fileUrl) {
    throw new ConversionError(`Conversion failed (${data.error ?? res.status}).`);
  }
  return downloadFromDocServer(data.fileUrl);
}

/**
 * Asks the Document Server to save the open document now (callback status 6).
 * Returns false when there is nothing to save (no changes were made).
 */
export async function forceSave(docKey: string): Promise<boolean> {
  const data = await command({ c: "forcesave", key: docKey });
  if (data.error === 0) return true;
  if (data.error === 4) return false; // document not modified
  throw new Error(`Force save failed (${data.error}).`);
}

async function command(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<{ error?: number; keys?: unknown }> {
  const res = await fetch(`${config.onlyofficeUrl}/coauthoring/CommandService.ashx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: signJwt(payload) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json().catch(() => ({ error: res.status }))) as { error?: number; keys?: unknown };
}

const SESSION_KEY_PREFIX = "sp";

/**
 * Deletes "forgotten" documents — copies the Document Server keeps, with no
 * expiry, when an editor closed and its save callback failed. Only keys this
 * app created (`sp…`) are touched; with `sessionId`, only that session's.
 * Best-effort: returns how many were deleted, 0 on any failure.
 */
export async function purgeForgotten(sessionId?: string): Promise<number> {
  if (!wordEditingEnabled()) return 0;
  const prefix = sessionId ? `${SESSION_KEY_PREFIX}${sessionId}r` : SESSION_KEY_PREFIX;
  try {
    const list = await command({ c: "getForgottenList" }, 5_000);
    const keys = Array.isArray(list.keys) ? list.keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix)) : [];
    let deleted = 0;
    for (const key of keys) {
      if ((await command({ c: "deleteForgotten", key }, 5_000)).error === 0) deleted++;
    }
    return deleted;
  } catch (err) {
    console.error("[SafePrint] purging forgotten Document Server copies failed:", err);
    return 0;
  }
}

/**
 * A Word edit round is over (approved, rejected, cancelled, or the session
 * ended): disconnect the editor so the Document Server stops holding the
 * document open, then delete any forgotten copy of this session. Best-effort.
 */
export async function releaseWordDocument(session: ISession, round = session.editRounds): Promise<void> {
  if (!wordEditingEnabled() || !session.source) return;
  try {
    await command({ c: "drop", key: `${SESSION_KEY_PREFIX}${String(session._id)}r${round}`, users: ["shop"] }, 5_000);
  } catch (err) {
    console.error("[SafePrint] disconnecting the Word editor failed:", err);
  }
  await purgeForgotten(String(session._id));
}

// ---------------------------------------------------------------------------
// Editor config
// ---------------------------------------------------------------------------

export interface CallbackRef {
  sid: string;
  round: number;
}

/** Document key: unique per session + edit round so no cached copy is reused across rounds. */
export function docKeyFor(session: ISession): string {
  return `${SESSION_KEY_PREFIX}${String(session._id)}r${session.editRounds}`;
}

// The Document Server fetches the source once when the editor opens.
const EDITOR_FILE_TTL_SECONDS = 600;

export function editorConfig(session: ISession, base: string, shopName: string) {
  const ext = session.sourceExt ?? "docx";
  // The callback must stay valid for as long as the edit can last.
  const ttl = config.sessionTtlSeconds + config.editTtlExtensionSeconds;
  const callback: CallbackRef = { sid: String(session._id), round: session.editRounds };
  const cfg = {
    documentType: "word",
    type: "desktop",
    width: "100%",
    height: "100%",
    document: {
      fileType: ext,
      key: docKeyFor(session),
      title: session.fileName,
      url: fileUrlFor(base, session.source!, ext, EDITOR_FILE_TTL_SECONDS),
      permissions: {
        edit: true,
        download: false,
        print: false,
        copy: false,
        comment: false,
        review: false,
        chat: false,
        protect: false,
        fillForms: true,
        modifyContentControl: true,
      },
    },
    editorConfig: {
      mode: "edit",
      lang: "en",
      callbackUrl: `${base}/api/onlyoffice/callback?t=${sealRef(callback, ttl)}`,
      user: { id: "shop", name: shopName },
      // "fast" streams edits to the Document Server as they happen, so the
      // server-side force-save (Send for approval) always has them.
      coEditing: { mode: "fast", change: false },
      customization: {
        forcesave: true,
        autosave: false,
        chat: false,
        comments: false,
        help: false,
        plugins: false,
        feedback: false,
        goback: false,
        hideRightMenu: false,
        compactHeader: true,
        toolbarHideFileName: true,
      },
    },
  };
  return { ...cfg, token: signJwt(cfg, config.onlyofficeJwtSecret, ttl) };
}
