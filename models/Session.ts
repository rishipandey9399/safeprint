import mongoose, { Schema, model, models, type Model } from "mongoose";

export type SessionStatus =
  | "awaiting_otp" // uploaded, waiting for the shop to enter the OTP
  | "awaiting_approval" // shop entered the right OTP, waiting for the citizen's Allow
  | "verified"     // OTP accepted, viewer token issued, document viewable
  | "printed"      // print confirmed, file deleted
  | "closed"       // shop closed the window without printing, file deleted
  | "locked"       // too many failed OTP attempts, file deleted
  | "expired";     // TTL hit, file deleted

export const FINAL_STATUSES: SessionStatus[] = ["printed", "closed", "locked", "expired"];

export interface ISession extends mongoose.Document {
  shareCode: string;
  otpHash: string;
  otpAttempts: number;
  otpExpiresAt: Date | null;
  otpRegenerations: number;
  shopId: mongoose.Types.ObjectId | null;
  approvalRequestedAt: Date | null;
  ownerTokenHash: string;
  viewerTokenHash: string | null;
  status: SessionStatus;
  printAttempts: number;
  renderCount: number;
  fileKey: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  // Envelope-encryption material; blanked on deletion (crypto-shredding).
  wrappedKey: string;
  keyIv: string;
  keyTag: string;
  fileIv: string;
  fileTag: string;
  createdAt: Date;
  expiresAt: Date;
}

const SessionSchema = new Schema<ISession>({
  shareCode: { type: String, required: true, index: true },
  otpHash: { type: String, required: true },
  otpAttempts: { type: Number, default: 0 },
  // Not required: sessions created before OTP expiry existed must still
  // save (e.g. when the sweep finalizes them). Missing = already expired.
  otpExpiresAt: { type: Date, default: null },
  otpRegenerations: { type: Number, default: 0 },
  shopId: { type: Schema.Types.ObjectId, ref: "Shop", default: null, index: true },
  approvalRequestedAt: { type: Date, default: null },
  ownerTokenHash: { type: String, required: true, index: true },
  viewerTokenHash: { type: String, default: null, index: true },
  status: {
    type: String,
    enum: ["awaiting_otp", "awaiting_approval", "verified", "printed", "closed", "locked", "expired"],
    default: "awaiting_otp",
    index: true,
  },
  printAttempts: { type: Number, default: 0 },
  renderCount: { type: Number, default: 0 },
  fileKey: { type: String, required: true },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  wrappedKey: { type: String, default: "" },
  keyIv: { type: String, default: "" },
  keyTag: { type: String, default: "" },
  fileIv: { type: String, default: "" },
  fileTag: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
});

export const Session: Model<ISession> =
  (models.Session as Model<ISession>) ?? model<ISession>("Session", SessionSchema);
