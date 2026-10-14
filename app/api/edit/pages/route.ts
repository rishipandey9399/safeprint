import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { submitEdit } from "@/lib/edits";
import { sniffFile } from "@/lib/fileType";
import { findVerifiedSession } from "@/lib/shopAuth";
import { editView } from "@/lib/sessionView";
import { rateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MIN_PT = 72; // 1 inch
const MAX_PT = 14400; // PDF user-space limit

/** Short, bounded list of tool names for the audit log. */
function readTools(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,24}$/.test(t)).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

/**
 * The image editor's output: one PNG/JPEG per page (rendered in the shop's
 * locked viewer) plus each page's physical size in PDF points. Assembled into
 * a PDF, encrypted, and held for the citizen's review — never sent back to
 * the shop's browser except through the locked viewer after approval.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`edit-pages:${ip}`, 20, 60 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  if (session.editStatus !== "editing" || session.editKind !== "image") {
    return NextResponse.json({ error: "Editing isn't allowed right now.", ...editView(session) }, { status: 409 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const pages = form.getAll("page").filter((p): p is File => p instanceof File);
  if (pages.length === 0 || pages.length > config.maxEditPages) {
    return NextResponse.json({ error: `Send between 1 and ${config.maxEditPages} pages.` }, { status: 400 });
  }
  let sizes: unknown;
  try {
    sizes = JSON.parse(String(form.get("sizes") ?? "[]"));
  } catch {
    sizes = null;
  }
  if (
    !Array.isArray(sizes) ||
    sizes.length !== pages.length ||
    !sizes.every(
      (s) => Array.isArray(s) && s.length === 2 && s.every((n) => typeof n === "number" && n >= MIN_PT && n <= MAX_PT)
    )
  ) {
    return NextResponse.json({ error: "Invalid page sizes." }, { status: 400 });
  }

  const total = pages.reduce((n, p) => n + p.size, 0);
  if (total > MAX_TOTAL_BYTES || pages.some((p) => p.size > config.maxFileBytes)) {
    return NextResponse.json({ error: "Edited pages are too large." }, { status: 413 });
  }

  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    const bytes = Buffer.from(await pages[i].arrayBuffer());
    const kind = sniffFile(bytes);
    if (kind.kind !== "image") {
      return NextResponse.json({ error: "Pages must be PNG or JPEG." }, { status: 415 });
    }
    let image;
    try {
      image = kind.mimeType === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    } catch {
      return NextResponse.json({ error: "A page image couldn't be read." }, { status: 400 });
    }
    const [w, h] = sizes[i] as [number, number];
    const page = pdf.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  pdf.setProducer("SafePrint");
  pdf.setCreator("SafePrint edit");
  const bytes = Buffer.from(await pdf.save());

  const ok = await submitEdit(session, { pdf: bytes, meta: { pages: pages.length, tools: readTools(form.get("tools")) } }, ip);
  if (!ok) return NextResponse.json({ error: "Editing isn't allowed right now." }, { status: 409 });
  session.editStatus = "pending_review";
  return NextResponse.json(editView(session));
}
