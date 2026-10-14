import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config, wordEditingEnabled } from "@/lib/config";
import { logAudit } from "@/lib/audit";
import { findVerifiedSession } from "@/lib/shopAuth";
import { editView } from "@/lib/sessionView";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Shop asks to edit the document. Nothing is editable until the citizen taps
 * Allow on their phone (/api/edit/decision); unanswered requests time out.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  let kind: unknown;
  try {
    kind = ((await req.json()) as { kind?: unknown }).kind;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (kind !== "word" && kind !== "image") {
    return NextResponse.json({ error: "Edit kind must be word or image." }, { status: 400 });
  }

  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });

  if (session.editStatus !== "none") {
    return NextResponse.json({ error: "An edit is already in progress.", ...editView(session) }, { status: 409 });
  }
  if (session.editRounds >= config.maxEditRounds) {
    return NextResponse.json({ error: "Edit limit reached for this document.", ...editView(session) }, { status: 403 });
  }
  if (kind === "word" && !(wordEditingEnabled() && session.source)) {
    return NextResponse.json({ error: "This document can't be edited as Word." }, { status: 409 });
  }

  session.editStatus = "requested";
  session.editKind = kind;
  session.editRequestedAt = new Date();
  await session.save();
  await logAudit(session._id as never, "edit_requested", ip, { kind });
  return NextResponse.json(editView(session));
}
