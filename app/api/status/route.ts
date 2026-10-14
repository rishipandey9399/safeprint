import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { findOwnerSession } from "@/lib/shopAuth";
import { ownerStatus } from "@/lib/sessionView";

export const runtime = "nodejs";

/**
 * Polling fallback for the uploader's page (the stream route is primary).
 * The owner token is accepted ONLY in the Authorization header.
 */
export async function GET(req: Request): Promise<NextResponse> {
  await connectDb();
  const session = await findOwnerSession(req);
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
  return NextResponse.json(await ownerStatus(session), { headers: { "Cache-Control": "no-store" } });
}
