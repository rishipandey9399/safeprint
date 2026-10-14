import { NextResponse } from "next/server";
import { wordEditingEnabled } from "@/lib/config";
import { readBlob } from "@/lib/blobs";
import { openRef, readDocServerJwt, type FileRef } from "@/lib/onlyoffice";

export const runtime = "nodejs";

/**
 * Serves a Word source file to the ONLYOFFICE Document Server only. Needs
 * BOTH a sealed short-lived reference (minted by this app, never shown to a
 * browser) and the Document Server's signed JWT. Not linked from any page.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!wordEditingEnabled() || !readDocServerJwt(req)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const ref = openRef<FileRef>(new URL(req.url).searchParams.get("t") ?? "");
  if (!ref?.blob?.key) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  let plain: Buffer;
  try {
    plain = await readBlob(ref.blob);
  } catch {
    // Blob shredded (session ended) or keys blanked.
    return NextResponse.json({ error: "Gone." }, { status: 410 });
  }
  return new NextResponse(new Uint8Array(plain), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(plain.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
