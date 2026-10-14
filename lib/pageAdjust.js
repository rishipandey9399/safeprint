// @ts-check
/**
 * Print-layout adjustments shared by the browser viewer and the desktop agent
 * (copied into agent/renderer/vendor by agent/scripts/copy-vendor.cjs, so this
 * file must stay a dependency-free ES module).
 *
 * Layout never changes what a page says: it turns, moves, scales and places
 * the page on paper, optionally in black & white, or leaves it out. Anything
 * that alters page content goes through the consented edit flow instead.
 */

/** @typedef {"auto" | "A4" | "Letter" | "Legal"} Paper */
/** @typedef {"fit" | "actual"} Fit */
/**
 * @typedef {object} Adjust
 * @property {0 | 90 | 180 | 270} rotate   clockwise quarter turns
 * @property {number} offsetXmm            move right (+) / left (−) on paper
 * @property {number} offsetYmm            move down (+) / up (−) on paper
 * @property {number} scalePct             on top of the fit mode
 * @property {Fit} fit                     "fit" = fill the paper, "actual" = true size
 * @property {Paper} paper                 "auto" = the page's own size
 * @property {boolean} include             false = skip when printing
 * @property {boolean} grayscale
 */

/** Paper sizes in millimetres, portrait. */
export const PAPER_MM = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
};

export const PT_PER_MM = 72 / 25.4;
export const MAX_OFFSET_MM = 40;
export const MIN_SCALE = 25;
export const MAX_SCALE = 200;

/** @returns {Adjust} */
export function defaultAdjust() {
  return { rotate: 0, offsetXmm: 0, offsetYmm: 0, scalePct: 100, fit: "fit", paper: "auto", include: true, grayscale: false };
}

/** @param {unknown} n @param {number} lo @param {number} hi @param {number} dflt */
function clampNum(n, lo, hi, dflt) {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/**
 * Validates untrusted input (the server runs this on what a browser sent).
 * @param {unknown} raw
 * @returns {Adjust}
 */
export function clampAdjust(raw) {
  const a = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  const d = defaultAdjust();
  const rot = Number(a.rotate);
  return {
    rotate: /** @type {Adjust["rotate"]} */ ([0, 90, 180, 270].includes(rot) ? rot : 0),
    offsetXmm: Math.round(clampNum(a.offsetXmm, -MAX_OFFSET_MM, MAX_OFFSET_MM, 0) * 10) / 10,
    offsetYmm: Math.round(clampNum(a.offsetYmm, -MAX_OFFSET_MM, MAX_OFFSET_MM, 0) * 10) / 10,
    scalePct: Math.round(clampNum(a.scalePct, MIN_SCALE, MAX_SCALE, 100)),
    fit: a.fit === "actual" ? "actual" : "fit",
    paper: a.paper === "A4" || a.paper === "Letter" || a.paper === "Legal" ? a.paper : d.paper,
    include: a.include !== false,
    grayscale: a.grayscale === true,
  };
}

/** @param {number} w @param {number} h @param {number} rotate */
export function rotatedSize(w, h, rotate) {
  return rotate === 90 || rotate === 270 ? [h, w] : [w, h];
}

/**
 * Where the page lands on paper, in millimetres.
 * @param {[number, number]} pageMm   the page's own size (unrotated)
 * @param {Adjust} adjust
 * @returns {{ paperMm: [number, number], drawMm: [number, number], centerMm: [number, number] }}
 *   drawMm is the unrotated page size after scaling; centerMm is where its centre goes.
 */
export function layout(pageMm, adjust) {
  const [cw, ch] = rotatedSize(pageMm[0], pageMm[1], adjust.rotate);
  /** @type {[number, number]} */
  let paperMm = [cw, ch];
  if (adjust.paper !== "auto") {
    const [pw, ph] = PAPER_MM[adjust.paper];
    // Paper follows the content's orientation.
    paperMm = cw > ch ? [ph, pw] : [pw, ph];
  }
  const fitScale = adjust.fit === "fit" ? Math.min(paperMm[0] / cw, paperMm[1] / ch) : 1;
  const s = fitScale * (adjust.scalePct / 100);
  return {
    paperMm,
    drawMm: [pageMm[0] * s, pageMm[1] * s],
    centerMm: [paperMm[0] / 2 + adjust.offsetXmm, paperMm[1] / 2 + adjust.offsetYmm],
  };
}

/** True when the adjustment changes nothing. @param {Adjust} a */
export function isDefault(a) {
  const d = defaultAdjust();
  return /** @type {(keyof Adjust)[]} */ (Object.keys(d)).every((k) => a[k] === d[k]);
}

/**
 * Draws `src` (a rendered page) onto a new paper-sized canvas.
 * @param {HTMLCanvasElement} src
 * @param {[number, number]} pageMm  the page's physical size
 * @param {Adjust} adjust
 * @param {Document} doc
 * @returns {HTMLCanvasElement}
 */
export function composePage(src, pageMm, adjust, doc) {
  const pxPerMm = src.width / pageMm[0];
  const { paperMm, drawMm, centerMm } = layout(pageMm, adjust);
  const out = doc.createElement("canvas");
  out.width = Math.max(1, Math.round(paperMm[0] * pxPerMm));
  out.height = Math.max(1, Math.round(paperMm[1] * pxPerMm));
  const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext("2d"));
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.save();
  if (adjust.grayscale) ctx.filter = "grayscale(1)";
  ctx.translate(centerMm[0] * pxPerMm, centerMm[1] * pxPerMm);
  ctx.rotate((adjust.rotate * Math.PI) / 180);
  const dw = drawMm[0] * pxPerMm;
  const dh = drawMm[1] * pxPerMm;
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  return out;
}

/**
 * Compact record of non-default adjustments for the audit log.
 * @param {Adjust[]} pages
 * @returns {{ changed: Record<string, Partial<Adjust>>, skipped: number[] } | null}
 */
export function summarizeAdjust(pages) {
  /** @type {Record<string, Partial<Adjust>>} */
  const changed = {};
  /** @type {number[]} */
  const skipped = [];
  const d = defaultAdjust();
  pages.forEach((p, i) => {
    if (!p.include) skipped.push(i + 1);
    /** @type {Partial<Adjust>} */
    const diff = {};
    for (const k of /** @type {(keyof Adjust)[]} */ (Object.keys(d))) {
      if (k !== "include" && p[k] !== d[k]) /** @type {any} */ (diff)[k] = p[k];
    }
    if (Object.keys(diff).length) changed[`p${i + 1}`] = diff;
  });
  return Object.keys(changed).length || skipped.length ? { changed, skipped } : null;
}
