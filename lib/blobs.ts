import crypto from "crypto";
import { decryptFile, encryptFile } from "./crypto";
import { getStorage } from "./storage";
import type { StoredBlob } from "@/models/Session";

/** Encrypts and stores a plaintext buffer; returns its storage key + envelope keys. */
export async function storeBlob(plain: Buffer): Promise<StoredBlob> {
  const { ciphertext, ...keys } = encryptFile(plain);
  const key = crypto.randomUUID();
  await getStorage().put(key, ciphertext);
  return { key, ...keys };
}

export async function readBlob(blob: StoredBlob): Promise<Buffer> {
  return decryptFile(await getStorage().get(blob.key), blob);
}

/**
 * Deletes a blob. Callers must also drop/blank the StoredBlob itself — the
 * keys going away is what makes any surviving copy unreadable.
 */
export async function deleteBlob(blob: Pick<StoredBlob, "key"> | null | undefined): Promise<void> {
  if (!blob?.key) return;
  try {
    await getStorage().delete(blob.key);
  } catch (err) {
    console.error(`[SafePrint] blob delete failed for ${blob.key}:`, err);
  }
}
