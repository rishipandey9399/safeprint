import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, readLimitedBody, readLimitedFormData } from "@/lib/body";

const streamOf = (chunks: number, size: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ >= chunks) return c.close();
      c.enqueue(new Uint8Array(size));
    },
  });
};

test("a declared oversized body is refused before reading anything", async () => {
  const req = new Request("http://x/", { method: "POST", body: "x", headers: { "content-length": "999999999" } });
  await assert.rejects(readLimitedBody(req, 1000), BodyTooLargeError);
});

test("a chunked body is cut off as soon as it passes the limit", async () => {
  let pulled = 0;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      if (sent++ >= 1000) return c.close(); // would be 64 MB if read fully
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const req = new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(readLimitedBody(req, 1024 * 1024), BodyTooLargeError);
  assert.ok(pulled < 40, `stopped early (pulled ${pulled} chunks)`);
});

test("bodies within the limit parse normally", async () => {
  const form = new FormData();
  form.append("a", "1");
  const req = new Request("http://x/", { method: "POST", body: form });
  assert.equal((await readLimitedFormData(req, 10_000)).get("a"), "1");
  const ok = new Request("http://x/", { method: "POST", body: streamOf(3, 100), duplex: "half" } as RequestInit);
  assert.equal((await readLimitedBody(ok, 1000)).length, 300);
});
