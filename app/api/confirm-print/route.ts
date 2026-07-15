import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { finalizeSession } from "@/lib/lifecycle";
import { findVerifiedSession } from "@/lib/shopAuth";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Operator confirmed the page came out of the printer. Deletes the file
 * immediately (well inside the 60-second requirement) and notifies the owner.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  await connectDb();

  const session = await findVerifiedSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  }
  if (session.printAttempts < 1) {
    return NextResponse.json({ error: "No print attempt was made." }, { status: 409 });
  }

  await finalizeSession(session, "printed", "print_confirmed", ip);
  return NextResponse.json({ ok: true, message: "Document printed and permanently deleted." });
}
