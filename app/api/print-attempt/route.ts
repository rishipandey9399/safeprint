import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { logAudit } from "@/lib/audit";
import { findVerifiedSession } from "@/lib/shopAuth";
import { getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** Called right before the viewer opens the browser print dialog. Max 2 per session. */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  await connectDb();

  const session = await findVerifiedSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  }

  if (session.editStatus !== "none") {
    return NextResponse.json(
      { error: "The document is being edited — wait for the customer's approval." },
      { status: 409 }
    );
  }

  if (session.printAttempts >= config.maxPrintAttempts) {
    return NextResponse.json(
      { error: "Print attempt limit reached.", attemptsLeft: 0 },
      { status: 403 }
    );
  }

  session.printAttempts += 1;
  await session.save();
  await logAudit(session._id as never, "print_attempt", ip, {
    attempt: session.printAttempts,
    client: req.headers.get("x-safeprint-client") ?? "browser",
  });

  return NextResponse.json({
    attempt: session.printAttempts,
    attemptsLeft: config.maxPrintAttempts - session.printAttempts,
  });
}
