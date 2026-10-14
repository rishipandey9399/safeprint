import { NextResponse } from "next/server";
import { wordEditingEnabled } from "@/lib/config";
import { readBlob } from "@/lib/blobs";
import { authorizeFileFetch, openRef, type FileRef } from "@/lib/onlyoffice";

export const runtime = "nodejs";

/**
 * Serves a Word source file to the ONLYOFFICE Document Server only. Needs
 * BOTH a sealed short-lived reference and a Document Server JWT signed for
 * that exact reference. The shop's browser sees the reference inside the
 * editor config, but cannot mint a matching JWT (the secret is server-side).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const t = wordEditingEnabled() ? authorizeFileFetch(req) : null;
  if (!t) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const ref = openRef<FileRef>(t);
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
