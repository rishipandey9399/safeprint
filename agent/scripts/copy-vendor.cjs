/**
 * Copies the pdf.js runtime out of node_modules into renderer/vendor so the
 * packaged app ships it without bundling all of node_modules (pdfjs-dist is a
 * devDependency; electron-builder only packages the files list).
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
