import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { logAudit } from "@/lib/audit";
import { findVerifiedSession } from "@/lib/shopAuth";
import { getClientIp } from "@/lib/rateLimit";
import { clampAdjust, summarizeAdjust } from "@/lib/pageAdjust";

const isMm = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n < 5000;

/**
 * Optional `{ layout: Adjust[], pageMm?: [w, h][] }` body: the print-layout
 * changes (and, with page sizes, pages whose content was pushed off the
 * paper), for the audit log only.
 */
async function readLayout(req: Request) {
  try {
    const body = (await req.json()) as { layout?: unknown; pageMm?: unknown };
    if (!Array.isArray(body.layout) || body.layout.length > 500) return null;
    const pageMm = Array.isArray(body.pageMm)
      ? body.pageMm.map((p) => (Array.isArray(p) && p.length === 2 && p.every(isMm) ? (p as [number, number]) : undefined))
      : undefined;
    return summarizeAdjust(body.layout.map(clampAdjust), pageMm);
  } catch {
    return null;
  }
}

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

  const layout = await readLayout(req);
  session.printAttempts += 1;
  await session.save();
  await logAudit(session._id as never, "print_attempt", ip, {
    attempt: session.printAttempts,
    client: req.headers.get("x-safeprint-client") ?? "browser",
    ...(layout ? { layout } : {}),
  });

  return NextResponse.json({
    attempt: session.printAttempts,
    attemptsLeft: config.maxPrintAttempts - session.printAttempts,
  });
}
