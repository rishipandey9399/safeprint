import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { docKeyFor, forceSave } from "@/lib/onlyoffice";
import { findVerifiedSession } from "@/lib/shopAuth";
import { editView } from "@/lib/sessionView";

export const runtime = "nodejs";

/**
 * "Send for approval" from the Word editor: asks the Document Server to save
 * now. The edited file arrives through /api/onlyoffice/callback, which moves
 * the session to pending_review; the shop keeps polling /api/edit/status.
 */
export async function POST(req: Request): Promise<NextResponse> {
  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  if (session.editStatus !== "editing" || session.editKind !== "word") {
    return NextResponse.json({ error: "No Word edit is open.", ...editView(session) }, { status: 409 });
  }

  try {
    const saved = await forceSave(docKeyFor(session));
    if (!saved) {
      return NextResponse.json(
        { error: "No changes to send yet — edit the document first.", ...editView(session) },
        { status: 409 }
      );
    }
  } catch (err) {
    console.error("[SafePrint] force save failed:", err);
    return NextResponse.json({ error: "Couldn't save the edit. Try again." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...editView(session) });
}
