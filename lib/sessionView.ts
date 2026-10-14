import { config } from "./config";
import type { ISession } from "@/models/Session";
import { Shop, shopLabel } from "@/models/Shop";

/** What the shop's viewer needs once the citizen has allowed access. */
export function viewerPayload(session: ISession) {
  return {
    fileName: session.fileName,
    mimeType: session.mimeType,
    fileSize: session.fileSize,
    expiresAt: session.expiresAt.toISOString(),
    printAttemptsLeft: config.maxPrintAttempts - session.printAttempts,
  };
}

export async function sessionShopName(session: ISession): Promise<string | null> {
  if (!session.shopId) return null;
  const shop = await Shop.findById(session.shopId);
  return shop ? shopLabel(shop) : null;
}

/** The citizen's live view of their session (status endpoint + stream). */
export async function ownerStatus(session: ISession) {
  return {
    status: session.status,
    fileName: session.fileName,
    expiresAt: session.expiresAt.toISOString(),
    otpExpiresAt: session.otpExpiresAt?.toISOString() ?? null,
    otpAttemptsLeft: Math.max(0, config.maxOtpAttempts - session.otpAttempts),
    otpRegenerationsLeft: Math.max(0, config.maxOtpRegenerations - session.otpRegenerations),
    printAttempts: session.printAttempts,
    shopName: await sessionShopName(session),
    approvalExpiresAt: session.approvalRequestedAt
      ? new Date(session.approvalRequestedAt.getTime() + config.approvalTimeoutSeconds * 1000).toISOString()
      : null,
  };
}
