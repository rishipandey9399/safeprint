import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { appBaseUrl, editorConfig } from "@/lib/onlyoffice";
import { config } from "@/lib/config";
import { findVerifiedSession } from "@/lib/shopAuth";
import { editView, sessionShopName } from "@/lib/sessionView";

export const runtime = "nodejs";

/**
 * Shop-side edit state, polled while waiting on the citizen. While a Word
 * edit is allowed, also returns the signed ONLYOFFICE editor config.
 */
export async function GET(req: Request): Promise<NextResponse> {
  await connectDb();
  const session = await findVerifiedSession(req);
  if (!session) return NextResponse.json({ error: "Not authorized or session ended." }, { status: 403 });

  const view = editView(session);
  if (session.editStatus === "editing" && session.editKind === "word" && view.wordEditable) {
    const shopName = (await sessionShopName(session)) ?? "Print shop";
    return NextResponse.json({
      ...view,
      onlyofficeUrl: config.onlyofficeUrl,
      editor: editorConfig(session, appBaseUrl(req), shopName),
    });
  }
  return NextResponse.json(view);
}
