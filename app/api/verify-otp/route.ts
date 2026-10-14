import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { generateToken, hashToken, hmacOtp, timingSafeEqualHex } from "@/lib/crypto";
import { finalizeSession, isExpired, isOtpExpired, resolveStaleApproval } from "@/lib/lifecycle";
import { findShopByKey } from "@/lib/shopAuth";
import { sessionShopName, viewerPayload } from "@/lib/sessionView";
import { logAudit } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

const NOT_FOUND = { error: "Invalid code, or session already used/expired." };

export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`verify:${ip}`, 15, 60 * 1000))) {
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

  const candidate = await Session.findOne({
    shareCode,
    status: { $in: ["awaiting_otp", "awaiting_approval"] },
  });
  // A citizen who never answered the Allow prompt frees the session again.
  if (candidate) await resolveStaleApproval(candidate);
  const session = candidate?.status === "awaiting_otp" ? candidate : null;
  if (!session) {
    // Deliberately vague: no oracle for which codes exist.
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  // A session paired with a counter opens only from that counter's device.
  const shop = await findShopByKey(req);
  if (session.shopId && !(shop && shop._id.equals(session.shopId))) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired", ip);
    return NextResponse.json({ error: "This session has expired." }, { status: 410 });
  }

  // Not counted as a wrong attempt — the OTP was right once, just stale.
  if (isOtpExpired(session)) {
    return NextResponse.json(
      { error: "This OTP has expired. Ask the customer to tap Regenerate and read you the new one." },
      { status: 410 }
    );
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

  // OTP correct. The viewer token is minted now but is useless until the
  // citizen taps Allow — every document endpoint requires status "verified".
  const viewerToken = generateToken();
  session.viewerTokenHash = hashToken(viewerToken);
  await logAudit(session._id as never, "otp_verified", ip, {
    client: req.headers.get("x-safeprint-client") ?? "browser",
    shopId: shop?._id ?? null,
  });

  if (config.autoApprove) {
    session.status = "verified";
    await session.save();
    await logAudit(session._id as never, "approval_granted", ip, { auto: true });
    return NextResponse.json({ viewerToken, pendingApproval: false, ...viewerPayload(session) });
  }

  session.status = "awaiting_approval";
  session.approvalRequestedAt = new Date();
  await session.save();
  await logAudit(session._id as never, "approval_requested", ip);

  return NextResponse.json({
    viewerToken,
    pendingApproval: true,
    shopName: await sessionShopName(session),
    approvalTimeoutSeconds: config.approvalTimeoutSeconds,
  });
}
