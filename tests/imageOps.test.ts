import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHomography, applyTone, quadOutputSize, solveHomography, type Quad } from "@/lib/imageOps";

const close = (a: number[], b: number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${a} vs ${b}`));

test("homography maps each corner of a skewed page onto the flat rectangle", () => {
  const skewed: Quad = [
    [40, 30],
    [610, 60],
    [580, 820],
    [20, 790],
  ];
  const flat: Quad = [
    [0, 0],
    [600, 0],
    [600, 800],
    [0, 800],
  ];
  const H = solveHomography(skewed, flat);
  skewed.forEach((p, i) => close(applyHomography(H, p), flat[i]));
  assert.throws(() => solveHomography([[0, 0], [0, 0], [0, 0], [0, 0]], flat), /Degenerate/);
});

test("perspective output size averages opposite edges", () => {
  assert.deepEqual(quadOutputSize([[0, 0], [100, 0], [100, 50], [0, 50]]), [100, 50]);
});

test("tone: brightness, contrast and B&W", () => {
  const px = new Uint8ClampedArray([100, 150, 200, 255]);
  applyTone(px, { brightness: 10, contrast: 0, grayscale: false });
  assert.deepEqual([...px], [126, 176, 226, 255]);
  const g = new Uint8ClampedArray([255, 0, 0, 255]);
  applyTone(g, { brightness: 0, contrast: 0, grayscale: true });
  assert.equal(g[0], g[1]);
  assert.equal(g[1], g[2]);
  assert.equal(g[3], 255, "alpha untouched");
});
