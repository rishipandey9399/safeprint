/**
 * Copies the pdf.js runtime out of node_modules into renderer/vendor so the
 * packaged app ships it without bundling all of node_modules (pdfjs-dist is a
 * devDependency; electron-builder only packages the files list). Also copies
 * the web app's dependency-free print-layout module, so the agent and the
 * browser viewer place pages on paper identically.
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "build");
const dest = path.join(__dirname, "..", "renderer", "vendor");

fs.mkdirSync(dest, { recursive: true });
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  console.log(`[copy-vendor] ${file} -> renderer/vendor/`);
}
fs.copyFileSync(path.join(__dirname, "..", "..", "lib", "pageAdjust.js"), path.join(dest, "pageAdjust.js"));
console.log("[copy-vendor] lib/pageAdjust.js -> renderer/vendor/");
