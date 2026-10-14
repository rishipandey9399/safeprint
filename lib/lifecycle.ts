import { getStorage } from "./storage";
import { config } from "./config";
import { generateOtp, hmacOtp } from "./crypto";
import { logAudit } from "./audit";
import { deleteBlob } from "./blobs";
import { Session, type ISession, type SessionStatus, FINAL_STATUSES } from "@/models/Session";
import type { AuditEvent } from "@/models/AuditLog";

/**
 * The ONLY place a session reaches a final state. Deletes the stored blob,
 * blanks the encryption keys in Mongo (crypto-shredding — even a surviving
 * blob copy is unreadable) and audits. The uploader's app learns the outcome
 * from its live status stream.
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

  // Original Word source and any unreviewed edit go with it.
  await deleteBlob(session.source);
  await deleteBlob(session.edited);
  await deleteBlob(session.editedSource);
  session.source = null;
  session.edited = null;
  session.editedSource = null;
  session.editStatus = "none";
  session.editRequestedAt = null;

  session.status = status;
  session.wrappedKey = "";
  session.keyIv = "";
  session.keyTag = "";
  session.fileIv = "";
  session.fileTag = "";
  session.viewerTokenHash = null;
  session.approvalRequestedAt = null;
  await session.save();

  await logAudit(session._id as never, event, ip);
  await logAudit(session._id as never, "file_deleted", ip);
}

export function isExpired(session: ISession): boolean {
  return session.expiresAt.getTime() <= Date.now();
}

export function isOtpExpired(session: ISession): boolean {
  return !session.otpExpiresAt || session.otpExpiresAt.getTime() <= Date.now();
}

/**
 * Mints a fresh OTP for the session (upload or citizen-requested regenerate):
 * resets the attempt counter and starts a new OTP lifetime, capped at the
 * session's own expiry. Returns the plaintext — the ONLY time it exists; it
 * goes straight to the citizen's screen and is never logged or stored.
 */
export function issueOtp(session: ISession): string {
  const otp = generateOtp();
  session.otpHash = hmacOtp(otp);
  session.otpAttempts = 0;
  session.otpExpiresAt = new Date(
    Math.min(Date.now() + config.otpTtlSeconds * 1000, session.expiresAt.getTime())
  );
  return otp;
}

/** Drops a pending shop approval: back to waiting for an OTP, viewer token void. */
export async function revokePendingApproval(
  session: ISession,
  event?: "approval_denied" | "approval_timeout",
  ip = ""
): Promise<void> {
  session.status = "awaiting_otp";
  session.viewerTokenHash = null;
  session.approvalRequestedAt = null;
  await session.save();
  if (event) await logAudit(session._id as never, event, ip);
}

/** If the citizen didn't answer the Allow prompt in time, revoke it. Returns true if it did. */
export async function resolveStaleApproval(session: ISession): Promise<boolean> {
  if (session.status !== "awaiting_approval" || !session.approvalRequestedAt) return false;
  const age = Date.now() - session.approvalRequestedAt.getTime();
  if (age < config.approvalTimeoutSeconds * 1000) return false;
  await revokePendingApproval(session, "approval_timeout");
  return true;
}

/** Ends an edit round without a new version: the current version stays the print copy. */
export async function cancelEdit(
  session: ISession,
  event: "edit_denied" | "edit_timeout" | "edit_cancelled" | "edit_rejected",
  ip = ""
): Promise<void> {
  await deleteBlob(session.edited);
  await deleteBlob(session.editedSource);
  session.edited = null;
  session.editedSource = null;
  session.editedSourceExt = null;
  session.editStatus = "none";
  session.editKind = null;
  session.editRequestedAt = null;
  // Every ended round counts, so a shop can't keep prompting the citizen.
  session.editRounds += 1;
  session.editLastOutcome = event.slice("edit_".length) as ISession["editLastOutcome"];
  await session.save();
  await logAudit(session._id as never, event, ip);
}

/** If the citizen didn't answer an edit request in time, drop it. Returns true if it did. */
export async function resolveStaleEditRequest(session: ISession): Promise<boolean> {
  if (session.editStatus !== "requested" || !session.editRequestedAt) return false;
  const age = Date.now() - session.editRequestedAt.getTime();
  if (age < config.approvalTimeoutSeconds * 1000) return false;
  await cancelEdit(session, "edit_timeout");
  return true;
}

/** Finalize any sessions whose TTL has passed. Shared by the cleanup job and lazy checks. */
export async function sweepExpiredSessions(): Promise<number> {
  const stale = await Session.find({
    status: { $in: ["awaiting_otp", "awaiting_approval", "verified"] },
    expiresAt: { $lte: new Date() },
  });
  for (const session of stale) {
    await finalizeSession(session, "expired", "session_expired");
  }

  const pending = await Session.find({
    status: "awaiting_approval",
    approvalRequestedAt: { $lte: new Date(Date.now() - config.approvalTimeoutSeconds * 1000) },
  });
  for (const session of pending) await resolveStaleApproval(session);

  const editRequests = await Session.find({
    status: "verified",
    editStatus: "requested",
    editRequestedAt: { $lte: new Date(Date.now() - config.approvalTimeoutSeconds * 1000) },
  });
  for (const session of editRequests) await resolveStaleEditRequest(session);

  return stale.length;
}
