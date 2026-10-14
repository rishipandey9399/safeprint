import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { wordEditingEnabled } from "@/lib/config";
import { submitEdit } from "@/lib/edits";
import { deleteBlob, storeBlob } from "@/lib/blobs";
import {
  appBaseUrl,
  convertToPdf,
  downloadFromDocServer,
  fileUrlFor,
  openRef,
  readDocServerJwt,
  type CallbackRef,
} from "@/lib/onlyoffice";
import { Session, type StoredBlob } from "@/models/Session";

export const runtime = "nodejs";

const ok = () => NextResponse.json({ error: 0 });

/**
 * Document Server save callback. Status 2 (all editors closed with changes)
 * or 6 (force-save from "Send for approval") delivers the edited .docx: we
 * store it, convert it to PDF for printing, and hand both to the citizen for
 * review. Anything else is acknowledged and ignored.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!wordEditingEnabled()) return NextResponse.json({ error: 1 }, { status: 403 });

  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 1 }, { status: 400 });
  }
  const body = readDocServerJwt(req, raw);
  const ref = openRef<CallbackRef>(new URL(req.url).searchParams.get("t") ?? "");
  if (!body || !ref) return NextResponse.json({ error: 1 }, { status: 403 });

  const status = body.status;
  const url = typeof body.url === "string" ? body.url : "";
  if ((status !== 2 && status !== 6) || !url) return ok();

  await connectDb();
  const session = await Session.findById(ref.sid);
  if (
    !session ||
    session.status !== "verified" ||
    session.editStatus !== "editing" ||
    session.editKind !== "word" ||
    session.editRounds !== ref.round
  ) {
    return ok(); // stale round, session over, or already submitted
  }

  // Store the edited file first, then convert it through our own sealed URL
  // (the result URL the Document Server hands out may only resolve outside it).
  let sourceBlob: StoredBlob | null = null;
  try {
    const ext = typeof body.filetype === "string" && body.filetype === "doc" ? "doc" : "docx";
    sourceBlob = await storeBlob(await downloadFromDocServer(url));
    const pdf = await convertToPdf(fileUrlFor(appBaseUrl(req), sourceBlob, ext), ext, "edited");
    const stored = await submitEdit(session, { pdf, sourceBlob, sourceExt: ext });
    if (!stored) sourceBlob = null; // submitEdit already deleted it
  } catch (err) {
    await deleteBlob(sourceBlob);
    console.error("[SafePrint] ONLYOFFICE save failed:", err);
    // Non-zero tells the Document Server the save failed; the shop can retry.
    return NextResponse.json({ error: 1 });
  }
  return ok();
}
