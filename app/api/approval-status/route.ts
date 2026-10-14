import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { finalizeSession, isExpired, resolveStaleApproval } from "@/lib/lifecycle";
import { readBearer } from "@/lib/shopAuth";
import { viewerPayload } from "@/lib/sessionView";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

/**
 * Polled by the shop while the citizen decides. The viewer token only
 * resolves while it is still attached to the session — a Deny or timeout
 * clears it, which reads here as "denied".
 */
export async function GET(req: Request): Promise<NextResponse> {
  const token = readBearer(req);
  if (!token) return NextResponse.json({ error: "Not authorized." }, { status: 403 });

  await connectDb();
  const session = await Session.findOne({ viewerTokenHash: hashToken(token) });
  if (!session) return NextResponse.json({ state: "denied" });

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired");
    return NextResponse.json({ state: "denied" });
  }
  if (await resolveStaleApproval(session)) return NextResponse.json({ state: "denied" });

  if (session.status === "verified") {
    return NextResponse.json({ state: "approved", ...viewerPayload(session) });
  }
  if (session.status === "awaiting_approval") return NextResponse.json({ state: "pending" });
  return NextResponse.json({ state: "denied" });
}
