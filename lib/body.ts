/**
 * Route handlers have no built-in body-size limit, and `req.formData()`
 * buffers the whole body before any size check could run. These helpers
 * refuse an oversized body up front (Content-Length) and cut off a body that
 * keeps streaming past the limit (chunked uploads), so a hostile request
 * can't make the server hold gigabytes in memory.
 */
export class BodyTooLargeError extends Error {}

export async function readLimitedBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return Buffer.alloc(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Multipart form data from a body capped at `maxBytes`. */
export async function readLimitedFormData(req: Request, maxBytes: number): Promise<FormData> {
  const body = await readLimitedBody(req, maxBytes);
  return new Response(new Uint8Array(body), {
    headers: { "Content-Type": req.headers.get("content-type") ?? "" },
  }).formData();
}
