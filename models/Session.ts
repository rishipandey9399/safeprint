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

/**
 * Shop-side editing, orthogonal to `status` (which stays "verified"):
 *   none → requested (shop asked) → editing (citizen allowed)
 *        → pending_review (edited version uploaded) → none (citizen approved/rejected)
 * Rendering and printing are refused unless this is "none".
 */
export type EditStatus = "none" | "requested" | "editing" | "pending_review";
export type EditKind = "word" | "image";

/** An encrypted blob in storage plus its envelope keys (blanked on shred). */
export interface StoredBlob {
  key: string;
  wrappedKey: string;
  keyIv: string;
  keyTag: string;
  fileIv: string;
  fileTag: string;
}

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
  // Original Word file (when the upload was converted to PDF), so it can be
  // edited as Word rather than as page images.
  source: StoredBlob | null;
  sourceExt: "docx" | "doc" | null;
  // Shop's edited version awaiting the citizen's review.
  edited: StoredBlob | null;
  editedSource: StoredBlob | null;
  editedSourceExt: "docx" | "doc" | null;
  editStatus: EditStatus;
  editKind: EditKind | null;
  editRequestedAt: Date | null;
  editRounds: number;
  editTtlExtended: boolean;
  // How the last edit round ended, so the shop's screen can say why.
  editLastOutcome: "approved" | "rejected" | "denied" | "timeout" | "cancelled" | null;
  createdAt: Date;
  expiresAt: Date;
  // Set when the session ends; MongoDB deletes the record at this time.
  purgeAt: Date | null;
}

const BlobSchema = new Schema<StoredBlob>(
  {
    key: { type: String, required: true },
    wrappedKey: { type: String, default: "" },
    keyIv: { type: String, default: "" },
    keyTag: { type: String, default: "" },
    fileIv: { type: String, default: "" },
    fileTag: { type: String, default: "" },
  },
  { _id: false }
);

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
  source: { type: BlobSchema, default: null },
  sourceExt: { type: String, enum: ["docx", "doc", null], default: null },
  edited: { type: BlobSchema, default: null },
  editedSource: { type: BlobSchema, default: null },
  editedSourceExt: { type: String, enum: ["docx", "doc", null], default: null },
  editStatus: {
    type: String,
    enum: ["none", "requested", "editing", "pending_review"],
    default: "none",
  },
  editKind: { type: String, enum: ["word", "image", null], default: null },
  editRequestedAt: { type: Date, default: null },
  editRounds: { type: Number, default: 0 },
  editTtlExtended: { type: Boolean, default: false },
  editLastOutcome: {
    type: String,
    enum: ["approved", "rejected", "denied", "timeout", "cancelled", null],
    default: null,
  },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  purgeAt: { type: Date, default: null },
});

// TTL: MongoDB removes ended sessions once purgeAt passes.
SessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const Session: Model<ISession> =
  (models.Session as Model<ISession>) ?? model<ISession>("Session", SessionSchema);
