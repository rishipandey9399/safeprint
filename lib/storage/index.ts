import { config } from "../config";
import { LocalStorageAdapter } from "./local";

/**
 * Storage holds ONLY ciphertext (encryption happens in lib/crypto before
 * put). Swapping local <-> GCS requires no changes to calling code.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

let instance: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (instance) return instance;
  if (config.storageDriver === "gcs") {
    // Lazy import so @google-cloud/storage is only required when actually used.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GcsStorageAdapter } = require("./gcs") as typeof import("./gcs");
    instance = new GcsStorageAdapter(config.gcsBucket);
  } else {
    instance = new LocalStorageAdapter(config.localStoreDir);
  }
  return instance;
}
