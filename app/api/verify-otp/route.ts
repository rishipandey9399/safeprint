import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { generateToken, hashToken, hmacOtp, timingSafeEqualHex } from "@/lib/crypto";
import { finalizeSession, isExpired, isOtpExpired, resolveStaleApproval } from "@/lib/lifecycle";
import { findShopByKey } from "@/lib/shopAuth";
import { sessionShopName, viewerPayload } from "@/lib/sessionView";
import { logAudit } from "@/lib/audit";
import { isLimited, rateLimit, getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

/**
 * One answer for every failure a stranger could probe — unknown code, a
 * session paired with another counter, wrong OTP, expired OTP or session,
 * lockout — so this endpoint can't be used to discover which share codes are
 * live. Only a counter presenting the paired device key gets specific messages
 * for its own sessions.
 */
const FAIL = { error: "Wrong code or OTP." };
const fail = () => NextResponse.json(FAIL, { status: 401 });
const BUSY = { error: "Too many attempts. Wait a minute and try again." };
const MISS_KEY = "verify-miss:global";

export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`verify:${ip}`, 15, 60 * 1000))) {
    return NextResponse.json(BUSY, { status: 429 });
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
  const shop = await findShopByKey(req);

  // Service-wide brake on guessing: past the miss budget, requests without a
  // counter key wait. Scanning share codes then takes days per hit, and the
  // worst an attacker achieves is a short pause for unpaired counters — not
  // destroyed documents. Registered counters are never braked.
  if (!shop && (await isLimited(MISS_KEY, config.verifyGlobalMissesPerMinute, 60 * 1000))) {
    return NextResponse.json(BUSY, { status: 429 });
  }
  // Per share code, independent of IP: slows any attack focused on one target.
  if (!(await rateLimit(`verify-code:${shareCode}`, config.verifyPerCodePerMinute, 60 * 1000))) {
    return NextResponse.json(BUSY, { status: 429 });
  }
  const miss = async () => {
    if (!shop) await rateLimit(MISS_KEY, Number.MAX_SAFE_INTEGER, 60 * 1000);
    return fail();
  };

  const candidate = await Session.findOne({
    shareCode,
    status: { $in: ["awaiting_otp", "awaiting_approval"] },
  });
  // A citizen who never answered the Allow prompt frees the session again.
  if (candidate) await resolveStaleApproval(candidate);
  const session = candidate?.status === "awaiting_otp" ? candidate : null;
  if (!session) return miss();

  // A session paired with a counter opens only from that counter's device.
  const ownCounter = !!(shop && session.shopId && shop._id.equals(session.shopId));
  if (session.shopId && !ownCounter) return miss();

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired", ip);
    return ownCounter ? NextResponse.json({ error: "This session has expired." }, { status: 410 }) : miss();
  }

  // Not counted as a wrong attempt — the OTP was right once, just stale.
  if (isOtpExpired(session)) {
    return ownCounter
      ? NextResponse.json(
          { error: "This OTP has expired. Ask the customer to tap Regenerate and read you the new one." },
          { status: 410 }
        )
      : miss();
  }

  if (!timingSafeEqualHex(hmacOtp(otp), session.otpHash)) {
    session.otpAttempts += 1;
    await session.save();
    await logAudit(session._id as never, "otp_failed", ip, { attempt: session.otpAttempts });

    if (session.otpAttempts >= config.maxOtpAttempts) {
      await finalizeSession(session, "locked", "session_locked", ip);
      return ownCounter
        ? NextResponse.json({ error: "Too many wrong OTPs. Session locked and document deleted." }, { status: 423 })
        : miss();
    }
    if (!ownCounter) return miss();
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
