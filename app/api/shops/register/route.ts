import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { generateShareCode, generateToken, hashToken } from "@/lib/crypto";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Shop } from "@/models/Shop";

export const runtime = "nodejs";

/**
 * One-time counter setup. Returns the device key exactly once; the counter
 * keeps it locally and sends it as X-SafePrint-Shop-Key. Lost key = register
 * again (the old counter's paired sessions simply expire).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`shop-register:${ip}`, 5, 60 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many registrations. Try again later." }, { status: 429 });
  }

  let body: { name?: unknown; area?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const area = typeof body.area === "string" ? body.area.trim().slice(0, 60) : "";
  if (name.length < 2) {
    return NextResponse.json({ error: "Enter the shop's name." }, { status: 400 });
  }

  await connectDb();

  let shopCode = generateShareCode();
  for (let i = 0; i < 10 && (await Shop.exists({ shopCode })); i++) shopCode = generateShareCode();

  const deviceKey = generateToken();
  await Shop.create({ name, area, shopCode, deviceKeyHash: hashToken(deviceKey) });

  return NextResponse.json({ shopCode, deviceKey, name, area });
}
