/**
 * Upload type detection. Never trust the client-declared MIME type or file
 * extension — sniff magic bytes (and, for Office files, the container's
 * entry names).
 */
export type SniffResult =
  | { kind: "pdf"; mimeType: "application/pdf" }
  | { kind: "image"; mimeType: "image/jpeg" | "image/png" }
  | { kind: "word"; ext: "docx" | "doc" }
  | { kind: "rejected"; reason: string };

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// ZIP local headers / central directory store entry names uncompressed, so a
// byte search finds them without unpacking anything.
const DOCX_MAIN = Buffer.from("word/document.xml", "latin1");
const DOCX_MACROS = Buffer.from("vbaProject.bin", "latin1");
// OLE directory entries are UTF-16LE; a Word 97-2003 file has this stream.
const DOC_STREAM = Buffer.from("WordDocument", "utf16le");
const DOC_MACROS = Buffer.from("Macros", "utf16le");

export function sniffFile(buf: Buffer): SniffResult {
  if (buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (buf.length > 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    if (!buf.includes(DOCX_MAIN)) return { kind: "rejected", reason: "not a Word document" };
    if (buf.includes(DOCX_MACROS)) return { kind: "rejected", reason: "macro-enabled Word files are not accepted" };
    return { kind: "word", ext: "docx" };
  }
  if (buf.length > 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    if (!buf.includes(DOC_STREAM)) return { kind: "rejected", reason: "not a Word document" };
    if (buf.includes(DOC_MACROS)) return { kind: "rejected", reason: "macro-enabled Word files are not accepted" };
    return { kind: "word", ext: "doc" };
  }
  return { kind: "rejected", reason: "unsupported file type" };
}
