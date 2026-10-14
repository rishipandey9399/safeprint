/**
 * Pixel operations for the page editor. The geometry/tone math is pure (and
 * unit-tested); the canvas helpers allocate new off-DOM canvases and never
 * produce URLs.
 */

export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt]; // top-left, top-right, bottom-right, bottom-left

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

/**
 * 3x3 homography (row-major, h[8] = 1) mapping each `from[i]` onto `to[i]`.
 * Solves the 8x8 linear system by Gaussian elimination with partial pivoting.
 */
export function solveHomography(from: Quad, to: Quad): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error("Degenerate corner selection.");
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[n] / row[i]);
  return [...h, 1];
}

export function applyHomography(h: number[], [x, y]: Pt): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Output size for a perspective fix: the average of opposite edge lengths. */
export function quadOutputSize(q: Quad): [number, number] {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
}

export interface Tone {
  brightness: number; // -100..100
  contrast: number; // -100..100
  grayscale: boolean;
}

/** Brightness/contrast/grayscale applied in place to RGBA pixels. */
export function applyTone(px: Uint8ClampedArray, t: Tone): void {
  const b = (t.brightness / 100) * 255;
  const c = Math.max(-99, Math.min(100, t.contrast));
  const f = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
  for (let i = 0; i < px.length; i += 4) {
    let r = f * (px[i] - 128) + 128 + b;
    let g = f * (px[i + 1] - 128) + 128 + b;
    let bl = f * (px[i + 2] - 128) + 128 + b;
    if (t.grayscale) r = g = bl = 0.299 * r + 0.587 * g + 0.114 * bl;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = bl;
  }
}

/**
 * "Scan cleanup": divides each pixel by an estimate of the paper's local
 * brightness (a heavily blurred copy), which flattens shadows and uneven
 * lighting in phone photos to white paper, then deepens the ink a little.
 */
export function cleanupPixels(px: Uint8ClampedArray, background: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const bg = Math.max(1, background[i + k]);
      const v = Math.min(255, (px[i + k] / bg) * 255);
      // Gentle curve: keep near-white white, darken mid tones (ink).
      px[i + k] = v > 235 ? 255 : Math.pow(v / 255, 1.6) * 255;
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas helpers (browser only)
// ---------------------------------------------------------------------------

function blank(w: number, h: number, white = true): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d")!;
  if (white) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return [c, ctx];
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const [c, ctx] = blank(src.width, src.height, false);
  ctx.drawImage(src, 0, 0);
  return c;
}

export function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const sx = Math.max(0, Math.round(x));
  const sy = Math.max(0, Math.round(y));
  const sw = Math.min(src.width - sx, Math.round(w));
  const sh = Math.min(src.height - sy, Math.round(h));
  const [c, ctx] = blank(sw, sh);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

/** Quarter turn: dir 1 = clockwise, -1 = counter-clockwise. */
export function rotate90(src: HTMLCanvasElement, dir: 1 | -1): HTMLCanvasElement {
  const [c, ctx] = blank(src.height, src.width);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Small-angle rotation that keeps the page size; uncovered corners are white. */
export function straighten(src: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const [c, ctx] = blank(src.width, src.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Maps the quad's contents onto a flat rectangle (bilinear sampling). */
export function warpPerspective(src: HTMLCanvasElement, quad: Quad): HTMLCanvasElement {
  const [w, h] = quadOutputSize(quad);
  // Inverse map: output rectangle → source quad.
  const H = solveHomography(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    quad
  );
  const sctx = src.getContext("2d")!;
  const sp = sctx.getImageData(0, 0, src.width, src.height).data;
  const [c, ctx] = blank(w, h);
  const out = ctx.createImageData(w, h);
  const op = out.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const fx = (H[0] * x + H[1] * y + H[2]) / d;
      const fy = (H[3] * x + H[4] * y + H[5]) / d;
      const o = (y * w + x) * 4;
      if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) {
        op[o] = op[o + 1] = op[o + 2] = op[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let k = 0; k < 4; k++) {
        const top = sp[i00 + k] * (1 - ax) + sp[i10 + k] * ax;
        const bot = sp[i01 + k] * (1 - ax) + sp[i11 + k] * ax;
        op[o + k] = top * (1 - ay) + bot * ay;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export function toneCanvas(src: HTMLCanvasElement, tone: Tone, cleanup: boolean): HTMLCanvasElement {
  const c = cloneCanvas(src);
  const ctx = c.getContext("2d")!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  if (cleanup) {
    // Background estimate: shrink, blur, scale back up.
    const small = Math.max(1, Math.round(Math.max(c.width, c.height) / 12));
    const scale = small / Math.max(c.width, c.height);
    const [s, sctx] = blank(c.width * scale, c.height * scale);
    sctx.filter = "blur(3px)";
    sctx.drawImage(src, 0, 0, s.width, s.height);
    const [bg, bgctx] = blank(c.width, c.height);
    bgctx.imageSmoothingQuality = "high";
    bgctx.drawImage(s, 0, 0, c.width, c.height);
    cleanupPixels(img.data, bgctx.getImageData(0, 0, c.width, c.height).data);
  }
  if (tone.brightness || tone.contrast || tone.grayscale) applyTone(img.data, tone);
  ctx.putImageData(img, 0, 0);
  return c;
}
