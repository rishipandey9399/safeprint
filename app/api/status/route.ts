import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { finalizeSession, isExpired } from "@/lib/lifecycle";
import { Session, FINAL_STATUSES } from "@/models/Session";

export const runtime = "nodejs";

/** Polled by the uploader's page to show live status + the deletion notification. */
export async function GET(req: Request): Promise<NextResponse> {
  const token = new URL(req.url).searchParams.get("ownerToken") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid token." }, { status: 400 });
  }

  await connectDb();
  const session = await Session.findOne({ ownerTokenHash: hashToken(token) });
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  if (!FINAL_STATUSES.includes(session.status) && isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired");
  }

  return NextResponse.json({
    status: session.status,
    fileName: session.fileName,
    expiresAt: session.expiresAt.toISOString(),
    otpAttempts: session.otpAttempts,
    printAttempts: session.printAttempts,
  });
}
