import type { StorageAdapter } from "./index";

/**
 * Production adapter for Google Cloud Storage. Requires:
 *   npm i @google-cloud/storage
 *   GOOGLE_APPLICATION_CREDENTIALS + GCS_BUCKET env vars
 *
 * Recommended bucket lifecycle rule (backstop in case the app dies before
 * cleanup runs — normal deletion is done by the app itself):
 *   gcloud storage buckets update gs://$GCS_BUCKET \
 *     --lifecycle-file=<(echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}')
 *
 * NOTE: we deliberately proxy file bytes through /api/render instead of
 * handing the shop browser a signed URL — any URL reachable from the shop
 * machine is a downloadable artifact, which defeats the product. Signed URLs
 * remain useful server-side (e.g. server-to-server transfer) via getSignedReadUrl.
 */
export class GcsStorageAdapter implements StorageAdapter {
  // Typed as any so the package is only needed when STORAGE_DRIVER=gcs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bucket: any;

  constructor(bucketName: string) {
    if (!bucketName) throw new Error("GCS_BUCKET env var is required for the gcs storage driver");
    // eval("require") keeps the optional dependency invisible to the bundler —
    // it is resolved at runtime only when STORAGE_DRIVER=gcs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Storage } = (eval("require") as NodeJS.Require)("@google-cloud/storage") as any;
    this.bucket = new Storage().bucket(bucketName);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.bucket.file(key).save(data, { resumable: false });
  }

  async get(key: string): Promise<Buffer> {
    const [contents] = await this.bucket.file(key).download();
    return contents;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }

  async getSignedReadUrl(key: string, expiresInSeconds = 60): Promise<string> {
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
    });
    return url;
  }
}
