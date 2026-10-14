import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Shop, shopLabel } from "@/models/Shop";

export const runtime = "nodejs";

/** Public: turns the shop code from a counter's QR into a name the citizen can confirm. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await rateLimit(`shop-lookup:${getClientIp(req)}`, 30, 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const code = (new URL(req.url).searchParams.get("code") ?? "").toUpperCase().trim();
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid shop code." }, { status: 400 });
  }

  await connectDb();
  const shop = await Shop.findOne({ shopCode: code });
  if (!shop) return NextResponse.json({ error: "No shop with that code." }, { status: 404 });
  return NextResponse.json({ shopCode: shop.shopCode, name: shop.name, area: shop.area, label: shopLabel(shop) });
}
