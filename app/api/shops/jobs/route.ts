import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { findShopByKey } from "@/lib/shopAuth";
import { shopLabel } from "@/models/Shop";
import { Session } from "@/models/Session";

export const runtime = "nodejs";

/** The counter's incoming queue: live sessions citizens paired with this shop. */
export async function GET(req: Request): Promise<NextResponse> {
  await connectDb();
  const shop = await findShopByKey(req);
  if (!shop) return NextResponse.json({ error: "Unknown counter. Set it up again." }, { status: 401 });

  const sessions = await Session.find({
    shopId: shop._id,
    status: { $in: ["awaiting_otp", "awaiting_approval"] },
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  return NextResponse.json(
    {
      shop: { name: shop.name, area: shop.area, shopCode: shop.shopCode, label: shopLabel(shop) },
      jobs: sessions.map((s) => ({
        shareCode: s.shareCode,
        status: s.status,
        fileName: s.fileName,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        otpExpiresAt: s.otpExpiresAt?.toISOString() ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
