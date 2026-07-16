import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { generateToken, hashToken, hmacOtp, timingSafeEqualHex } from "@/lib/crypto";
import { finalizeSession, isExpired } from "@/lib/lifecycle";
import { logAudit } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!rateLimit(`verify:${ip}`, 15, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  }

  let body: { shareCode?: string; otp?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const shareCode = (body.shareCode ?? "").toUpperCase().trim();
  const otp = (body.otp ?? "").trim();
  if (!/^[A-Z2-9]{6}$/.test(shareCode) || !/^\d{6}$/.test(otp)) {
    return NextResponse.json({ error: "Enter the 6-character code and 6-digit OTP." }, { status: 400 });
  }

  await connectDb();

  const session = await Session.findOne({ shareCode, status: "awaiting_otp" });
  if (!session) {
    // Deliberately vague: no oracle for which codes exist.
    return NextResponse.json({ error: "Invalid code, or session already used/expired." }, { status: 404 });
  }

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired", ip);
    return NextResponse.json({ error: "This session has expired." }, { status: 410 });
  }

  if (!timingSafeEqualHex(hmacOtp(otp), session.otpHash)) {
    session.otpAttempts += 1;
    await session.save();
    await logAudit(session._id as never, "otp_failed", ip, { attempt: session.otpAttempts });

    if (session.otpAttempts >= config.maxOtpAttempts) {
      await finalizeSession(session, "locked", "session_locked", ip);
      return NextResponse.json(
        { error: "Too many wrong OTPs. Session locked and document deleted." },
        { status: 423 }
      );
    }
    const left = config.maxOtpAttempts - session.otpAttempts;
    return NextResponse.json({ error: `Wrong OTP. ${left} attempt(s) left.` }, { status: 401 });
  }

  // OTP + share code verified — issue the one-time viewer token.
  const viewerToken = generateToken();
  session.viewerTokenHash = hashToken(viewerToken);
  session.status = "verified";
  await session.save();
  await logAudit(session._id as never, "otp_verified", ip, {
    client: req.headers.get("x-safeprint-client") ?? "browser",
  });

  return NextResponse.json({
    viewerToken,
    fileName: session.fileName,
    mimeType: session.mimeType,
    fileSize: session.fileSize,
    expiresAt: session.expiresAt.toISOString(),
    printAttemptsLeft: config.maxPrintAttempts - session.printAttempts,
  });
}
