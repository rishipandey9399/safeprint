import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + database reachability, for the container health check. */
export async function GET() {
  try {
    const db = await connectDb();
    await db.connection.db!.admin().ping();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
