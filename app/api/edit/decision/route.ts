import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { cancelEdit } from "@/lib/lifecycle";
import { extendForEditing } from "@/lib/edits";
import { findOwnerSession } from "@/lib/shopAuth";
import { ownerStatus } from "@/lib/sessionView";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** The citizen's Allow / Deny on the shop's request to edit. */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  let decision: unknown;
  try {
    decision = ((await req.json()) as { decision?: unknown }).decision;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (decision !== "allow" && decision !== "deny") {
    return NextResponse.json({ error: "Decision must be allow or deny." }, { status: 400 });
  }

  await connectDb();
  const session = await findOwnerSession(req);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (session.status !== "verified" || session.editStatus !== "requested") {
    return NextResponse.json(
      { error: "No edit request is waiting.", ...(await ownerStatus(session)) },
      { status: 409 }
    );
  }

  if (decision === "allow") {
    session.editStatus = "editing";
    session.editRequestedAt = null;
    extendForEditing(session);
    await session.save();
    await logAudit(session._id as never, "edit_granted", ip, { kind: session.editKind });
  } else {
    await cancelEdit(session, "edit_denied", ip);
  }
  return NextResponse.json(await ownerStatus(session));
}
