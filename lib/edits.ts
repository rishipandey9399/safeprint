import { config } from "./config";
import { logAudit } from "./audit";
import { deleteBlob, storeBlob } from "./blobs";
import { getStorage } from "./storage";
import { Session, type ISession } from "@/models/Session";

/**
 * Stores a shop's edited version and moves the session to pending_review.
 * The state change is a conditional update, so of two racing submissions
 * (e.g. a Document Server force-save and close callback) only one wins and
 * the loser's blobs are deleted.
 */
export async function submitEdit(
  session: ISession,
  edit: { pdf: Buffer; source?: Buffer; sourceExt?: "docx" | "doc"; meta?: Record<string, unknown> },
  ip = ""
): Promise<boolean> {
  const edited = await storeBlob(edit.pdf);
  const editedSource = edit.source ? await storeBlob(edit.source) : null;

  const won = await Session.findOneAndUpdate(
    { _id: session._id, status: "verified", editStatus: "editing", editRounds: session.editRounds },
    {
      $set: {
        edited,
        editedSource,
        editedSourceExt: editedSource ? (edit.sourceExt ?? "docx") : null,
        editStatus: "pending_review",
      },
    }
  );
  if (!won) {
    await deleteBlob(edited);
    await deleteBlob(editedSource);
    return false;
  }
  await logAudit(session._id as never, "edit_submitted", ip, {
    kind: session.editKind,
    round: session.editRounds + 1,
    bytes: edit.pdf.length,
    ...edit.meta,
  });
  return true;
}

/**
 * Citizen approved the edit: the edited PDF becomes the print copy (and an
 * edited .docx the new Word source); the replaced versions are shredded.
 */
export async function approveEdit(session: ISession, ip = ""): Promise<void> {
  const edited = session.edited!;
  const oldFileKey = session.fileKey;
  const replacedSourceKey = session.editedSource ? (session.source?.key ?? null) : null;

  session.fileKey = edited.key;
  session.wrappedKey = edited.wrappedKey;
  session.keyIv = edited.keyIv;
  session.keyTag = edited.keyTag;
  session.fileIv = edited.fileIv;
  session.fileTag = edited.fileTag;
  session.mimeType = "application/pdf";
  if (session.editedSource) {
    session.source = session.editedSource;
    session.sourceExt = session.editedSourceExt ?? "docx";
  }
  session.edited = null;
  session.editedSource = null;
  session.editedSourceExt = null;
  session.editStatus = "none";
  session.editKind = null;
  session.editRequestedAt = null;
  session.editRounds += 1;
  // Fresh render budget for the new version.
  session.renderCount = 0;
  await session.save();

  try {
    await getStorage().delete(oldFileKey);
  } catch (err) {
    console.error(`[SafePrint] blob delete failed for ${oldFileKey}:`, err);
  }
  if (replacedSourceKey) await deleteBlob({ key: replacedSourceKey });
  await logAudit(session._id as never, "edit_approved", ip, { round: session.editRounds });
}

/** Extends the session TTL once per session when the citizen first allows an edit. */
export function extendForEditing(session: ISession): void {
  if (session.editTtlExtended) return;
  session.editTtlExtended = true;
  session.expiresAt = new Date(session.expiresAt.getTime() + config.editTtlExtensionSeconds * 1000);
}
