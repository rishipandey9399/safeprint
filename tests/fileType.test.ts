import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffFile } from "@/lib/fileType";

const zip = (...names: string[]) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), ...names.map((n) => Buffer.from(`..${n}..`, "latin1"))]);
const ole = (...streams: string[]) =>
  Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), ...streams.map((s) => Buffer.from(s, "utf16le"))]);

test("PDF and images are recognised by magic bytes", () => {
  assert.deepEqual(sniffFile(Buffer.from("%PDF-1.7 ...")), { kind: "pdf", mimeType: "application/pdf" });
  assert.equal(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])).kind, "image");
  assert.deepEqual(sniffFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), {
    kind: "image",
    mimeType: "image/png",
  });
});

test("Word files are recognised; macro-enabled ones and other zips/OLE files are not", () => {
  assert.deepEqual(sniffFile(zip("[Content_Types].xml", "word/document.xml")), { kind: "word", ext: "docx" });
  assert.equal(sniffFile(zip("word/document.xml", "word/vbaProject.bin")).kind, "rejected");
  assert.equal(sniffFile(zip("xl/workbook.xml")).kind, "rejected");
  assert.deepEqual(sniffFile(ole("Root Entry", "WordDocument", "1Table")), { kind: "word", ext: "doc" });
  assert.equal(sniffFile(ole("WordDocument", "Macros")).kind, "rejected");
  assert.equal(sniffFile(ole("Workbook")).kind, "rejected");
});

test("anything else is rejected, whatever its name claims", () => {
  assert.equal(sniffFile(Buffer.from("MZ\x90\x00 not a document")).kind, "rejected");
  assert.equal(sniffFile(Buffer.alloc(0)).kind, "rejected");
});
