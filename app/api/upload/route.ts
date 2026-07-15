import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { config } from "@/lib/config";
import { encryptFile, generateOtp, generateShareCode, generateToken, hashToken, hmacOtp } from "@/lib/crypto";
import { getStorage } from "@/lib/storage";
import { getOtpProvider } from "@/lib/otp";
import { logAudit } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/rateLimit";
import { Session } from "@/models/Session";
import crypto from "crypto";

export const runtime = "nodejs";

// Never trust the client-declared MIME type — sniff magic bytes.
function sniffMimeType(buf: Buffer): string | null {
  if (buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!rateLimit(`upload:${ip}`, 10, 60 * 60 * 1000)) {
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

  const bytes = Buffer.from(await file.arrayBuffer());
  const mimeType = sniffMimeType(bytes);
  if (!mimeType) {
    return NextResponse.json({ error: "Only PDF, JPEG, or PNG files are supported." }, { status: 415 });
  }

  const phone = typeof form.get("phone") === "string" ? (form.get("phone") as string).slice(0, 20) : "";

  await connectDb();

  // Encrypt before anything touches storage.
  const { ciphertext, ...keys } = encryptFile(bytes);
  const fileKey = crypto.randomUUID();
  await getStorage().put(fileKey, ciphertext);

  // Share code must be unique among sessions a shop could still open.
  let shareCode = generateShareCode();
  for (let i = 0; i < 5; i++) {
    const clash = await Session.exists({ shareCode, status: { $in: ["awaiting_otp", "verified"] } });
    if (!clash) break;
    shareCode = generateShareCode();
  }

  const otp = generateOtp();
  const ownerToken = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);

  const session = await Session.create({
    shareCode,
    otpHash: hmacOtp(otp),
    ownerTokenHash: hashToken(ownerToken),
    fileKey,
    fileName: file.name.slice(0, 200) || "document",
    mimeType,
    fileSize: file.size,
    ...keys,
    expiresAt,
  });
  if (phone) {
    session.phone = phone;
    await session.save();
  }

  await logAudit(session._id as never, "upload", ip, { fileName: session.fileName, size: file.size });
  await getOtpProvider().sendOtp(phone, otp);

  // The OTP is returned to the UPLOADER's own screen — they relay it to the
  // shop in person. The shop portal never receives it from the server.
  return NextResponse.json({
    shareCode,
    otp,
    ownerToken,
    fileName: session.fileName,
    expiresAt: expiresAt.toISOString(),
  });
}
