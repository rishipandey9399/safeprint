import { hashToken } from "./crypto";
import { finalizeSession, isExpired, resolveStaleApproval, resolveStaleEditRequest } from "./lifecycle";
import { Session, FINAL_STATUSES, type ISession } from "@/models/Session";
import { Shop, type IShop } from "@/models/Shop";

const TOKEN_RE = /^[a-f0-9]{64}$/;

/**
 * Tokens travel only in headers — never in a URL — so there is no address
 * anyone could bookmark, log, or re-open.
 */
export function readBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return TOKEN_RE.test(token) ? token : null;
}

/** Resolves the shop's viewer token (issued only after OTP + citizen approval) to a live session. */
export async function findVerifiedSession(req: Request): Promise<ISession | null> {
  const token = readBearer(req);
  if (!token) return null;

  const session = await Session.findOne({
    viewerTokenHash: hashToken(token),
    status: "verified",
  });
  if (!session) return null;

  if (isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired");
    return null;
  }
  await resolveStaleEditRequest(session);
  return session;
}

/**
 * Resolves the citizen's owner token to their session (any status), applying
 * lazy TTL expiry and approval timeout so the caller always sees fresh state.
 */
export async function findOwnerSession(req: Request): Promise<ISession | null> {
  const token = readBearer(req);
  if (!token) return null;

  const session = await Session.findOne({ ownerTokenHash: hashToken(token) });
  if (!session) return null;

  if (!FINAL_STATUSES.includes(session.status) && isExpired(session)) {
    await finalizeSession(session, "expired", "session_expired");
  } else {
    await resolveStaleApproval(session);
    await resolveStaleEditRequest(session);
  }
  return session;
}

export const SHOP_KEY_HEADER = "x-safeprint-shop-key";

/** Resolves a registered counter from its device key header. */
export async function findShopByKey(req: Request): Promise<IShop | null> {
  const key = req.headers.get(SHOP_KEY_HEADER) ?? "";
  if (!TOKEN_RE.test(key)) return null;
  const shop = await Shop.findOne({ deviceKeyHash: hashToken(key) });
  if (!shop) return null;
  // Cheap liveness marker; not awaited-critical, but keep it consistent.
  shop.lastSeenAt = new Date();
  await shop.save();
  return shop;
}

export function readViewerTokenFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const token = (body as Record<string, unknown>).viewerToken;
  return typeof token === "string" && TOKEN_RE.test(token) ? token : null;
}
