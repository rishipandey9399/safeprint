import { hashToken } from "./crypto";
import { finalizeSession, isExpired } from "./lifecycle";
import { Session, type ISession } from "@/models/Session";

/**
 * Resolves the shop's viewer token (issued only after OTP verification) to a
 * live session. The token travels in the Authorization header — never in a
 * URL — so there is no address the operator could bookmark or re-open.
 */
export async function findVerifiedSession(req: Request): Promise<ISession | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;

  const session = await Session.findOne({
    viewerTokenHash: hashToken(token),
    status: "verified",
  });
  if (!session) return null;

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired");
    return null;
  }
  return session;
}

export function readViewerTokenFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const token = (body as Record<string, unknown>).viewerToken;
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
