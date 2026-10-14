import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { decryptFile } from "@/lib/crypto";
import { getStorage } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { findVerifiedSession } from "@/lib/shopAuth";
import { rateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Serves decrypted bytes to the locked viewer. Requires the post-OTP viewer
 * token in the Authorization header, so the response is unreachable via any
 * URL the browser (or operator) could save, bookmark, or cache. Headers
 * forbid caching; Content-Disposition is inline (never attachment).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`render:${ip}`, 30, 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });
  }

  if (session.renderCount >= config.maxRenderFetches) {
    return NextResponse.json({ error: "Render limit reached for this session." }, { status: 429 });
  }
  session.renderCount += 1;
  await session.save();

  let plain: Buffer;
  try {
    const ciphertext = await getStorage().get(session.fileKey);
    plain = decryptFile(ciphertext, session);
  } catch (err) {
    console.error("[SafePrint] render decrypt failed:", err);
    return NextResponse.json({ error: "Document unavailable." }, { status: 410 });
  }

  await logAudit(session._id as never, "render", ip, { fetch: session.renderCount });

  return new NextResponse(new Uint8Array(plain), {
    status: 200,
    headers: {
      "Content-Type": session.mimeType,
      "Content-Length": String(plain.length),
      "Content-Disposition": "inline",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
