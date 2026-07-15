import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { finalizeSession } from "@/lib/lifecycle";
import { readViewerTokenFromBody } from "@/lib/shopAuth";
import { getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

/**
 * Fired via navigator.sendBeacon when the shop closes/leaves the viewer
 * without confirming a print. Beacons can't set headers, so the token rides
 * in the JSON body. Always responds 204 — no oracle about token validity.
 */
export async function POST(req: Request): Promise<NextResponse> {
  await connectDb();

  let token: string | null = null;
  try {
    token = readViewerTokenFromBody(JSON.parse(await req.text()));
  } catch {
    // fall through — respond 204 regardless
  }

  if (token) {
    const session = await Session.findOne({
      viewerTokenHash: hashToken(token),
      status: "verified",
    });
    if (session) {
      await finalizeSession(session, "closed", "session_closed", getClientIp(req));
    }
  }
  return new NextResponse(null, { status: 204 });
}
