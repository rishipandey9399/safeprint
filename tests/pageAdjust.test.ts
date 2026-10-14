import { test } from "node:test";
import assert from "node:assert/strict";
import { clampAdjust, defaultAdjust, isDefault, isOffPaper, layout, rotatedSize, sheetPlan, summarizeAdjust } from "@/lib/pageAdjust";

test("clampAdjust bounds untrusted input", () => {
  assert.deepEqual(clampAdjust(null), defaultAdjust());
  const a = clampAdjust({ rotate: 45, offsetXmm: 999, offsetYmm: -999, scalePct: 5, fit: "zoom", paper: "A0", include: 0, grayscale: "yes" });
  assert.deepEqual(a, { ...defaultAdjust(), rotate: 0, offsetXmm: 40, offsetYmm: -40, scalePct: 25 });
  assert.equal(clampAdjust({ include: false }).include, false);
  assert.equal(clampAdjust({ scalePct: 200 }).scalePct, 100, "no enlarging past the paper");
  assert.equal(clampAdjust({ rotate: 270, paper: "Legal" }).rotate, 270);
});

test("layout: auto paper keeps the page's own (rotated) size", () => {
  assert.deepEqual(rotatedSize(210, 297, 90), [297, 210]);
  const l = layout([210, 297], { ...defaultAdjust(), rotate: 90 });
  assert.deepEqual(l.paperMm, [297, 210]);
  assert.deepEqual(l.drawMm, [210, 297]);
  assert.deepEqual(l.centerMm, [148.5, 105]);
});

test("layout: fit onto A4 follows orientation, scale and offsets apply", () => {
  // Letter page onto A4: width-bound fit.
  const l = layout([215.9, 279.4], { ...defaultAdjust(), paper: "A4", scalePct: 50, offsetXmm: 5, offsetYmm: -3 });
  assert.deepEqual(l.paperMm, [210, 297]);
  const s = (210 / 215.9) * 0.5;
  assert.ok(Math.abs(l.drawMm[0] - 215.9 * s) < 1e-9);
  assert.deepEqual(l.centerMm, [110, 145.5]);
  // Landscape content gets landscape paper; actual size is not scaled.
  const land = layout([297, 210], { ...defaultAdjust(), paper: "A4", fit: "actual" });
  assert.deepEqual(land.paperMm, [297, 210]);
  assert.deepEqual(land.drawMm, [297, 210]);
});

test("summarizeAdjust records only what changed", () => {
  assert.equal(summarizeAdjust([defaultAdjust(), defaultAdjust()]), null);
  assert.ok(isDefault(defaultAdjust()));
  const s = summarizeAdjust([{ ...defaultAdjust(), rotate: 90 }, { ...defaultAdjust(), include: false }]);
  assert.deepEqual(s, { changed: { p1: { rotate: 90 } }, skipped: [2] });
});

test("isOffPaper flags content pushed off the sheet", () => {
  const a4: [number, number] = [210, 297];
  assert.equal(isOffPaper(a4, defaultAdjust()), false);
  assert.equal(isOffPaper(a4, { ...defaultAdjust(), paper: "A4", scalePct: 80, offsetXmm: 15 }), false, "shrunk page has room to move");
  assert.equal(isOffPaper(a4, { ...defaultAdjust(), paper: "A4", offsetXmm: 5 }), true);
  assert.equal(isOffPaper(a4, { ...defaultAdjust(), paper: "A4", offsetYmm: 0.5 }), false, "within tolerance");
  // Legal page at actual size on A4 overhangs.
  assert.equal(isOffPaper([215.9, 355.6], { ...defaultAdjust(), paper: "A4", fit: "actual" }), true);
  const s = summarizeAdjust([{ ...defaultAdjust(), paper: "A4", offsetXmm: 5 }], [a4]);
  assert.deepEqual(s?.offPaper, [1]);
});

test("sheetPlan: one sheet orientation per job, opposite pages turned", () => {
  const P: [number, number] = [210, 297];
  const L: [number, number] = [297, 210];
  assert.deepEqual(sheetPlan([P, P]), { landscape: false, rotate: [false, false] });
  assert.deepEqual(sheetPlan([L, L]), { landscape: true, rotate: [false, false] });
  assert.deepEqual(sheetPlan([P, L, P]), { landscape: false, rotate: [false, true, false] });
  assert.deepEqual(sheetPlan([]), { landscape: false, rotate: [] });
});
