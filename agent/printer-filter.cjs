/**
 * Physical-vs-virtual printer classification. Kept as a pure module (no
 * Electron imports) so it can be unit-tested with plain Node.
 *
 * Heuristic, not cryptographic: an admin can install a virtual driver with a
 * physical-looking name. Combined with the watermark + audit log this raises
 * the bar from one-click saving to deliberate circumvention.
 */
const VIRTUAL_PRINTER_RE = new RegExp(
  [
    "print to pdf",
    "save as pdf",
    "microsoft print",
    "microsoft xps",
    "xps document",
    "onenote",
    "fax",
    "cups-pdf",
    "pdf24",
    "cutepdf",
    "bullzip",
    "dopdf",
    "novapdf",
    "pdfcreator",
    "adobe pdf",
    "foxit.*pdf",
    "nitro pdf",
    "snagit",
    "anydesk",
    "evernote",
    "send to",
    "generic.*pdf",
    "virtual",
  ].join("|"),
  "i"
);

function splitPrinters(printers) {
  const physical = [];
  const filtered = [];
  for (const p of printers) {
    const haystack = [p.name, p.displayName, p.description, p.options?.["printer-make-and-model"]]
      .filter(Boolean)
      .join(" | ");
    (VIRTUAL_PRINTER_RE.test(haystack) ? filtered : physical).push({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description || "",
    });
  }
  return { physical, filtered };
}

module.exports = { splitPrinters, VIRTUAL_PRINTER_RE };
