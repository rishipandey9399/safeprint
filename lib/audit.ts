import type mongoose from "mongoose";
import { AuditLog, type AuditEvent } from "@/models/AuditLog";

export async function logAudit(
  sessionId: mongoose.Types.ObjectId,
  event: AuditEvent,
  ip = "",
  meta: Record<string, unknown> = {}
): Promise<void> {
  await AuditLog.create({ sessionId, event, ip, meta });
}
