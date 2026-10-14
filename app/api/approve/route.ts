import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { revokePendingApproval } from "@/lib/lifecycle";
import { findOwnerSession } from "@/lib/shopAuth";
import { ownerStatus } from "@/lib/sessionView";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** The citizen's Allow / Deny on a shop that entered the correct OTP. */
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
  if (session.status !== "awaiting_approval") {
    return NextResponse.json(
      { error: "No shop is waiting for approval.", ...(await ownerStatus(session)) },
      { status: 409 }
    );
  }

  if (decision === "allow") {
    session.status = "verified";
    session.approvalRequestedAt = null;
    await session.save();
    await logAudit(session._id as never, "approval_granted", ip);
  } else {
    await revokePendingApproval(session, "approval_denied", ip);
  }
  return NextResponse.json(await ownerStatus(session));
}
