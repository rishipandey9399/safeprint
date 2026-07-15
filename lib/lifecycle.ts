import { getStorage } from "./storage";
import { getOtpProvider } from "./otp";
import { logAudit } from "./audit";
import { Session, type ISession, type SessionStatus, FINAL_STATUSES } from "@/models/Session";
import type { AuditEvent } from "@/models/AuditLog";

const OUTCOME_MESSAGES: Record<string, string> = {
  printed: "Your document was printed and has been permanently deleted from SafePrint.",
  closed: "The shop closed the viewer without printing. Your document has been permanently deleted.",
  locked: "Too many wrong OTP entries. Your document was permanently deleted without being viewed.",
  expired: "Your SafePrint session expired. The document was permanently deleted without being printed.",
};

/**
 * The ONLY place a session reaches a final state. Deletes the stored blob,
 * blanks the encryption keys in Mongo (crypto-shredding — even a surviving
 * blob copy is unreadable), audits, and notifies the uploader.
 */
export async function finalizeSession(
  session: ISession,
  status: SessionStatus & ("printed" | "closed" | "locked" | "expired"),
  event: AuditEvent,
  ip = ""
): Promise<void> {
  if (FINAL_STATUSES.includes(session.status)) return; // already finalized

  try {
    await getStorage().delete(session.fileKey);
  } catch (err) {
    console.error(`[SafePrint] blob delete failed for ${session.fileKey}:`, err);
    // Keys are still blanked below, so the blob is unreadable regardless;
    // the storage lifecycle rule / cleanup dir is the physical backstop.
  }

  session.status = status;
  session.wrappedKey = "";
  session.keyIv = "";
  session.keyTag = "";
  session.fileIv = "";
  session.fileTag = "";
  session.viewerTokenHash = null;
  await session.save();

  await logAudit(session._id as never, event, ip);
  await logAudit(session._id as never, "file_deleted", ip);
  await getOtpProvider().notify(session.phone, OUTCOME_MESSAGES[status]);
}

export function isExpired(session: ISession): boolean {
  return session.expiresAt.getTime() <= Date.now();
}

/** Finalize any sessions whose TTL has passed. Shared by the cleanup job and lazy checks. */
export async function sweepExpiredSessions(): Promise<number> {
  const stale = await Session.find({
    status: { $in: ["awaiting_otp", "verified"] },
    expiresAt: { $lte: new Date() },
  });
  for (const session of stale) {
    await finalizeSession(session, "expired", "session_expired");
  }
  return stale.length;
}
