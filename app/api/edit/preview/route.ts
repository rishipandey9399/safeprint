import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { readBlob } from "@/lib/blobs";
import { findOwnerSession } from "@/lib/shopAuth";

export const runtime = "nodejs";

/** The shop's edited version, for the citizen to review on their own phone. */
export async function GET(req: Request): Promise<NextResponse> {
  await connectDb();
  const session = await findOwnerSession(req);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (session.status !== "verified" || session.editStatus !== "pending_review" || !session.edited) {
    return NextResponse.json({ error: "No edited version is waiting for review." }, { status: 409 });
  }

  let plain: Buffer;
  try {
    plain = await readBlob(session.edited);
  } catch {
    return NextResponse.json({ error: "Edited version unavailable." }, { status: 410 });
  }
  return new NextResponse(new Uint8Array(plain), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(plain.length),
      "Content-Disposition": "inline",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
