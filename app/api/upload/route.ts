import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config, wordEditingEnabled } from "@/lib/config";
import { encryptFile, generateShareCode, generateToken, hashToken } from "@/lib/crypto";
import { getStorage } from "@/lib/storage";
import { deleteBlob, storeBlob } from "@/lib/blobs";
import { sniffFile } from "@/lib/fileType";
import { appBaseUrl, convertToPdf, fileUrlFor } from "@/lib/onlyoffice";
import type { StoredBlob } from "@/models/Session";
import { issueOtp } from "@/lib/lifecycle";
import { logAudit } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";
import { Shop, shopLabel } from "@/models/Shop";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!(await rateLimit(`upload:${ip}`, 10, 60 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many uploads. Try again later." }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file." }, { status: 400 });
  }
  if (file.size > config.maxFileBytes) {
    return NextResponse.json({ error: "File too large (max 15 MB)." }, { status: 413 });
  }

  let bytes: Buffer = Buffer.from(await file.arrayBuffer());
  // Never trust the client-declared MIME type — sniff magic bytes.
  const sniffed = sniffFile(bytes);
  if (sniffed.kind === "rejected") {
    return NextResponse.json(
      { error: `Only PDF, Word, JPEG, or PNG files are supported (${sniffed.reason}).` },
      { status: 415 }
    );
  }
  if (sniffed.kind === "word") {
    if (!wordEditingEnabled()) {
      return NextResponse.json(
        { error: "Word files aren't supported on this server yet — save it as PDF and upload that." },
        { status: 415 }
      );
    }
    if (!(await rateLimit(`upload-word:${ip}`, 5, 60 * 60 * 1000))) {
      return NextResponse.json({ error: "Too many Word uploads. Try again later." }, { status: 429 });
    }
  }

  const rawShopCode = form.get("shopCode");
  const shopCode = typeof rawShopCode === "string" ? rawShopCode.toUpperCase().trim() : "";

  await connectDb();

  // Optional pairing with the counter whose QR the citizen scanned. A paired
  // session can only be opened from that counter's registered device.
  let shop = null;
  if (shopCode) {
    shop = /^[A-Z2-9]{6}$/.test(shopCode) ? await Shop.findOne({ shopCode }) : null;
    if (!shop) {
      return NextResponse.json({ error: "Unknown shop code. Check it with the shop." }, { status: 400 });
    }
  }

  // Word files: keep the original (encrypted) so the shop can edit it as
  // Word later, and print from a PDF rendition made by the Document Server,
  // which fetches the original over a sealed, short-lived server-only URL.
  let source: StoredBlob | null = null;
  let mimeType: string = sniffed.kind === "word" ? "application/pdf" : sniffed.mimeType;
  if (sniffed.kind === "word") {
    source = await storeBlob(bytes);
    try {
      bytes = await convertToPdf(fileUrlFor(appBaseUrl(req), source, sniffed.ext), sniffed.ext);
    } catch (err) {
      console.error("[SafePrint] Word conversion failed:", err);
      await deleteBlob(source);
      return NextResponse.json(
        { error: "Couldn't open this Word file. Save it as PDF and upload that instead." },
        { status: 422 }
      );
    }
    if (sniffFile(bytes).kind !== "pdf") {
      await deleteBlob(source);
      return NextResponse.json({ error: "Word conversion produced an invalid file." }, { status: 502 });
    }
    mimeType = "application/pdf";
  }

  // Encrypt before anything touches storage.
  const { ciphertext, ...keys } = encryptFile(bytes);
  const fileKey = crypto.randomUUID();
  await getStorage().put(fileKey, ciphertext);

  // Share code must be unique among sessions a shop could still open.
  let shareCode = generateShareCode();
  for (let i = 0; i < 5; i++) {
    const clash = await Session.exists({ shareCode, status: { $in: ["awaiting_otp", "awaiting_approval", "verified"] } });
    if (!clash) break;
    shareCode = generateShareCode();
  }

  const ownerToken = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);

  const session = new Session({
    shareCode,
    shopId: shop?._id ?? null,
    ownerTokenHash: hashToken(ownerToken),
    fileKey,
    fileName: file.name.slice(0, 200) || "document",
    mimeType,
    fileSize: file.size,
    ...keys,
    source,
    sourceExt: sniffed.kind === "word" ? sniffed.ext : null,
    expiresAt,
  });
  const otp = issueOtp(session);
  await session.save();

  await logAudit(session._id as never, "upload", ip, {
    fileName: session.fileName,
    size: file.size,
    shopId: shop?._id ?? null,
  });
  if (sniffed.kind === "word") {
    await logAudit(session._id as never, "word_converted", ip, { from: sniffed.ext });
  }

  // The OTP is returned ONLY to the uploader's own screen (like a ride OTP)
  // — they say it to the operator in person. It is never logged, sent
  // anywhere else, or stored except as an HMAC.
  return NextResponse.json({
    shareCode,
    otp,
    ownerToken,
    fileName: session.fileName,
    expiresAt: expiresAt.toISOString(),
    otpExpiresAt: session.otpExpiresAt!.toISOString(),
    shopName: shop ? shopLabel(shop) : null,
    convertedFrom: sniffed.kind === "word" ? sniffed.ext : null,
  });
}
