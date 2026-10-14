import mongoose, { Schema, model, models, type Model } from "mongoose";

export type AuditEvent =
  | "upload"
  | "otp_failed"
  | "otp_verified"
  | "otp_regenerated"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "approval_timeout"
  | "session_locked"
  | "render"
  | "print_attempt"
  | "print_confirmed"
  | "session_closed"
  | "session_expired"
  | "file_deleted";

export interface IAuditLog extends mongoose.Document {
  sessionId: mongoose.Types.ObjectId;
  event: AuditEvent;
  ip: string;
  at: Date;
  meta: Record<string, unknown>;
}

const AuditLogSchema = new Schema<IAuditLog>({
  sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
  event: { type: String, required: true },
  ip: { type: String, default: "" },
  at: { type: Date, default: Date.now },
  meta: { type: Schema.Types.Mixed, default: {} },
});

export const AuditLog: Model<IAuditLog> =
  (models.AuditLog as Model<IAuditLog>) ?? model<IAuditLog>("AuditLog", AuditLogSchema);
