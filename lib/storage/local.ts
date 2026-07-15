import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import type { StorageAdapter } from "./index";

/**
 * Dev-only stand-in for GCS. Blobs written here are already AES-256-GCM
 * ciphertext, so the directory contents are unreadable without the DB-held
 * wrapped keys. Delete overwrites with random bytes before unlinking as a
 * best-effort against trivial undelete tools.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private ready: Promise<void>;

  constructor(private dir: string) {
    this.ready = fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {});
  }

  private resolve(key: string): string {
    if (!/^[a-f0-9-]+$/.test(key)) throw new Error("Invalid storage key");
    return path.join(this.dir, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.ready;
    await fs.writeFile(this.resolve(key), data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    await this.ready;
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    const file = this.resolve(key);
    try {
      const { size } = await fs.stat(file);
      await fs.writeFile(file, crypto.randomBytes(size));
      await fs.unlink(file);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
