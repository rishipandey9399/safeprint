import crypto from "crypto";
import { config } from "./config";
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
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
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
  if (!decoded) return null;
  // Header tokens wrap the request body under `payload`; body tokens are the body.
  const inner = decoded.payload;
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : decoded;
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

/** Converts the document at `sourceUrl` (reachable by the Document Server) to PDF. */
export async function convertToPdf(sourceUrl: string, ext: string, title = "document"): Promise<Buffer> {
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
  const payload = { c: "forcesave", key: docKey };
  const res = await fetch(`${config.onlyofficeUrl}/coauthoring/CommandService.ashx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: signJwt(payload) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: number };
  if (data.error === 0) return true;
  if (data.error === 4) return false; // document not modified
  throw new Error(`Force save failed (${data.error ?? res.status}).`);
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
  return `sp${String(session._id)}r${session.editRounds}`;
}

export function editorConfig(session: ISession, base: string, shopName: string) {
  const ext = session.sourceExt ?? "docx";
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
      url: fileUrlFor(base, session.source!, ext, ttl),
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
