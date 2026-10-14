import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { issueOtp, revokePendingApproval } from "@/lib/lifecycle";
import { findOwnerSession } from "@/lib/shopAuth";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Citizen asks for a new OTP (expired, overheard, or a shop they denied).
 * The old OTP stops working immediately and any pending approval is dropped.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  await connectDb();
  const session = await findOwnerSession(req);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  if (session.status !== "awaiting_otp" && session.status !== "awaiting_approval") {
    return NextResponse.json({ error: "The OTP can no longer be changed for this session." }, { status: 409 });
  }
  if (session.otpRegenerations >= config.maxOtpRegenerations) {
    return NextResponse.json({ error: "No more new OTPs for this session." }, { status: 429 });
  }

  if (session.status === "awaiting_approval") await revokePendingApproval(session);
  const otp = issueOtp(session);
  session.otpRegenerations += 1;
  await session.save();
  await logAudit(session._id as never, "otp_regenerated", ip, { count: session.otpRegenerations });

  return NextResponse.json({
    otp,
    otpExpiresAt: session.otpExpiresAt!.toISOString(),
    otpRegenerationsLeft: config.maxOtpRegenerations - session.otpRegenerations,
  });
}
