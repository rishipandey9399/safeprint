import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { cancelEdit } from "@/lib/lifecycle";
import { approveEdit } from "@/lib/edits";
import { findOwnerSession } from "@/lib/shopAuth";
import { ownerStatus } from "@/lib/sessionView";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * The citizen approves or rejects the shop's edited version. Approve makes
 * it the print copy (the old version is shredded); reject shreds the edit and
 * the shop prints the version from before.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  let decision: unknown;
  try {
    decision = ((await req.json()) as { decision?: unknown }).decision;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "Decision must be approve or reject." }, { status: 400 });
  }

  await connectDb();
  const session = await findOwnerSession(req);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (session.status !== "verified" || session.editStatus !== "pending_review" || !session.edited) {
    return NextResponse.json(
      { error: "No edited version is waiting for review.", ...(await ownerStatus(session)) },
      { status: 409 }
    );
  }

  if (decision === "approve") await approveEdit(session, ip);
  else await cancelEdit(session, "edit_rejected", ip);
  return NextResponse.json(await ownerStatus(session));
}
