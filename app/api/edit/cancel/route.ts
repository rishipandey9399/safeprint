import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { cancelEdit } from "@/lib/lifecycle";
import { findVerifiedSession } from "@/lib/shopAuth";
import { editView } from "@/lib/sessionView";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** Shop withdraws an edit request or abandons an open edit; the current version stays. */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  if (session.editStatus !== "requested" && session.editStatus !== "editing") {
    return NextResponse.json({ error: "Nothing to cancel.", ...editView(session) }, { status: 409 });
  }
  await cancelEdit(session, "edit_cancelled", ip);
  return NextResponse.json(editView(session));
}
