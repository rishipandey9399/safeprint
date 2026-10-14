import { before, test } from "node:test";
import assert from "node:assert/strict";

process.env.ONLYOFFICE_URL = "http://docs.internal:8080";
process.env.ONLYOFFICE_JWT_SECRET = "unit-secret";

// Imported after the env is set, since config reads it at load time.
let oo: typeof import("@/lib/onlyoffice");
before(async () => {
  oo = await import("@/lib/onlyoffice");
});

test("JWTs verify only with the right secret, untampered and unexpired", () => {
  const t = oo.signJwt({ a: 1 });
  assert.equal(oo.verifyJwt(t)?.a, 1);
  assert.equal(oo.verifyJwt(t, "other-secret"), null);
  const [h, , s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ a: 2, exp: 9e9 })).toString("base64url");
  assert.equal(oo.verifyJwt(`${h}.${forged}.${s}`), null);
  assert.equal(oo.verifyJwt(oo.signJwt({ a: 1 }, "unit-secret", -10)), null, "expired");
  assert.equal(oo.verifyJwt("not.a.jwt"), null);
});

test("Document Server JWT is read from the body token or the Authorization header", () => {
  const body = { status: 6, url: "x" };
  const fromBody = oo.readDocServerJwt(new Request("http://a/"), { ...body, token: oo.signJwt(body) });
  assert.equal(fromBody?.status, 6);
  const fromHeader = oo.readDocServerJwt(
    new Request("http://a/", { headers: { Authorization: `Bearer ${oo.signJwt({ payload: body })}` } })
  );
  assert.equal(fromHeader?.status, 6);
  assert.equal(oo.readDocServerJwt(new Request("http://a/"), body), null);
});

test("sealed references round-trip, expire, and can't be altered", () => {
  const t = oo.sealRef({ sid: "abc", round: 1 });
  assert.deepEqual(oo.openRef(t), { sid: "abc", round: 1 });
  assert.equal(oo.openRef(oo.sealRef({ x: 1 }, -1)), null, "expired");
  const raw = Buffer.from(t, "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(oo.openRef(raw.toString("base64url")), null, "tampered");
  assert.equal(oo.openRef("garbage"), null);
});

test("only Document Server URLs are fetched", () => {
  assert.equal(oo.isDocServerUrl("http://docs.internal:8080/cache/files/x/output.docx"), true);
  assert.equal(oo.isDocServerUrl("http://docs.internal:9999/x"), false);
  assert.equal(oo.isDocServerUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(oo.isDocServerUrl("file:///etc/passwd"), false);
});
