import { describe, expect, it } from "vitest";
import { parseCube } from "../../../../shared/cubeLut.mjs";
import { applyLut, prepareLut } from "./lutKernel";
import { cubeText } from "./cubeLut.test";

// Every 8-bit RGB triple on a coarse grid, plus some in between.
function samplePixels() {
  const values = [0, 1, 7, 31, 64, 100, 127, 128, 170, 200, 254, 255];
  const px = [];
  for (const r of values) for (const g of values) for (const b of values) px.push(r, g, b, 255);
  return new Uint8ClampedArray(px);
}

const prepared = (n, f, header) => prepareLut(parseCube(cubeText(n, f, { header })));

// Float reference: tetrahedral interpolation of f's lattice, as written in
// the literature (no table scaling, no lookup tables).
function referenceTetra(n, f, r8, g8, b8) {
  const node = (i, j, k) => f(i / (n - 1), j / (n - 1), k / (n - 1));
  const x = (r8 / 255) * (n - 1), y = (g8 / 255) * (n - 1), z = (b8 / 255) * (n - 1);
  const i = Math.min(Math.floor(x), n - 2), j = Math.min(Math.floor(y), n - 2), k = Math.min(Math.floor(z), n - 2);
  const fr = x - i, fg = y - j, fb = z - k;
  const c = (di, dj, dk) => node(i + di, j + dj, k + dk);
  let corners;
  if (fr >= fg && fg >= fb) corners = [[c(0, 0, 0), 1 - fr], [c(1, 0, 0), fr - fg], [c(1, 1, 0), fg - fb], [c(1, 1, 1), fb]];
  else if (fr >= fb && fb >= fg) corners = [[c(0, 0, 0), 1 - fr], [c(1, 0, 0), fr - fb], [c(1, 0, 1), fb - fg], [c(1, 1, 1), fg]];
  else if (fb >= fr && fr >= fg) corners = [[c(0, 0, 0), 1 - fb], [c(0, 0, 1), fb - fr], [c(1, 0, 1), fr - fg], [c(1, 1, 1), fg]];
  else if (fg >= fr && fr >= fb) corners = [[c(0, 0, 0), 1 - fg], [c(0, 1, 0), fg - fr], [c(1, 1, 0), fr - fb], [c(1, 1, 1), fb]];
  else if (fg >= fb && fb >= fr) corners = [[c(0, 0, 0), 1 - fg], [c(0, 1, 0), fg - fb], [c(0, 1, 1), fb - fr], [c(1, 1, 1), fr]];
  else corners = [[c(0, 0, 0), 1 - fb], [c(0, 0, 1), fb - fg], [c(0, 1, 1), fg - fr], [c(1, 1, 1), fr]];
  return [0, 1, 2].map((ch) => corners.reduce((sum, [v, w]) => sum + v[ch] * w, 0) * 255);
}

describe("applyLut", () => {
  it("an identity LUT leaves every pixel as it was, alpha included", () => {
    const px = samplePixels();
    px[3] = 7;
    const before = px.slice();
    applyLut(px, prepared(17));
    expect([...px]).toEqual([...before]);
  });

  it("affine LUTs come out exact: swapping channels, inverting", () => {
    const swap = samplePixels();
    const src = swap.slice();
    applyLut(swap, prepared(2, (r, g, b) => [b, r, g]));
    for (let p = 0; p < src.length; p += 4) expect([swap[p], swap[p + 1], swap[p + 2]]).toEqual([src[p + 2], src[p], src[p + 1]]);
    const inv = samplePixels();
    applyLut(inv, prepared(5, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    for (let p = 0; p < src.length; p += 4) expect(inv[p]).toBe(255 - src[p]);
  });

  it("matches a float tetrahedral reference within one level on a curved LUT", () => {
    const f = (r, g, b) => [Math.sqrt(r) * 0.9 + 0.05 * b, g ** 2.2, (r + g + b) / 3];
    const px = samplePixels();
    const src = px.slice();
    applyLut(px, prepared(9, f));
    let worst = 0;
    for (let p = 0; p < src.length; p += 4) {
      const ref = referenceTetra(9, f, src[p], src[p + 1], src[p + 2]);
      for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(px[p + ch] - Math.min(255, Math.max(0, ref[ch]))));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("strength mixes the original and the graded value in the same 0..255 values", () => {
    const lut = prepared(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
    const one = (k) => [...applyLut(new Uint8ClampedArray([200, 100, 0, 255]), lut, k)];
    expect(one(0)).toEqual([200, 100, 0, 255]);
    expect(one(1)).toEqual([55, 155, 255, 255]);
    // 200 + 0.5·(55 − 200) = 127.5: either neighbour, depending on the float
    // table's last bit. The preview draws the 8-bit graded picture at
    // globalAlpha 0.5, which lands within the same level.
    for (const v of one(0.5).slice(0, 3)) expect(Math.abs(v - 127.5)).toBeLessThanOrEqual(0.5);
    const quarter = one(0.25);
    expect(Math.abs(quarter[0] - (200 + 0.25 * (55 - 200)))).toBeLessThanOrEqual(0.5);
  });

  it("folds the LUT's input domain in: a LUT made for 0..0.5 reads 255 as its top node", () => {
    // Identity over [0, 0.5]: input 0.25 (≈64) sits mid-lattice → output 0.25·… scaled.
    const lut = prepared(3, (r, g, b) => [r, g, b], "DOMAIN_MIN 0 0 0\nDOMAIN_MAX 0.5 0.5 0.5\n");
    const px = new Uint8ClampedArray([64, 128, 255, 255]);
    applyLut(px, lut);
    // (v/255)/0.5 clamped to 1, then the identity table → 2v (capped).
    expect([...px]).toEqual([128, 255, 255, 255]);
  });

  it("clamps graded values outside 0..1 on output only", () => {
    const px = new Uint8ClampedArray([255, 0, 128, 255]);
    applyLut(px, prepared(2, (r, g, b) => [r * 1.5, g - 0.2, b]));
    expect([...px]).toEqual([255, 0, 128, 255]);
  });
});
