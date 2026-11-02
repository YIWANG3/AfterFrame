// Applying a 3D LUT to 8-bit RGBA pixels (docs/lut-plan.md §3).
//
// Tetrahedral interpolation: four lattice reads per pixel instead of
// trilinear's eight, so it is the faster one in JS (24 MP in ~0.4 s on an M1
// Max, single thread), and it is what Resolve, darktable and FFmpeg default
// to. Strength mixes the original and the LUT's output in the same encoded
// sRGB values the LUT reads — out = in + k·(LUT(in) − in) — which is also
// what drawing the graded picture over the original with globalAlpha = k
// does, so the editor's live preview and the saved file agree.

// A parsed LUT (shared/cubeLut.mjs) made ready to apply: the table scaled to
// 0..255 once, and for each channel the lattice cell and fraction of all 256
// input values, with the LUT's domain folded in.
export function prepareLut({ size, table, domainMin = [0, 0, 0], domainMax = [1, 1, 1] }) {
  const t255 = new Float32Array(table.length);
  for (let i = 0; i < table.length; i++) t255[i] = table[i] * 255;
  const n1 = size - 1;
  const axes = [0, 1, 2].map((c) => {
    const idx = new Int32Array(256);
    const frac = new Float32Array(256);
    const lo = domainMin[c];
    const span = domainMax[c] - lo;
    for (let v = 0; v < 256; v++) {
      const unit = Math.min(1, Math.max(0, (v / 255 - lo) / span));
      const x = unit * n1;
      let i = Math.floor(x);
      if (i >= n1) i = n1 - 1;
      idx[v] = i;
      frac[v] = x - i;
    }
    return { idx, frac };
  });
  return { size, table: t255, axes };
}

/**
 * Grades `pixels` (RGBA, 0..255) in place. Alpha is left alone.
 * @param {Uint8ClampedArray} pixels
 * @param {ReturnType<typeof prepareLut>} lut
 * @param {number} strength 0..1
 */
export function applyLut(pixels, lut, strength = 1) {
  const k = Math.min(1, Math.max(0, strength));
  if (k === 0) return pixels;
  const { size, table: t } = lut;
  const [ra, ga, ba] = lut.axes;
  const sR = 3, sG = 3 * size, sB = 3 * size * size, sAll = sR + sG + sB;
  for (let p = 0; p < pixels.length; p += 4) {
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    const fr = ra.frac[r], fg = ga.frac[g], fb = ba.frac[b];
    const o = ra.idx[r] * sR + ga.idx[g] * sG + ba.idx[b] * sB;
    // The tetrahedron the point falls in: corners 000 → a → c → 111.
    let a, c, w0, w1, w2, w3;
    if (fr >= fg) {
      if (fg >= fb) { a = sR; c = sR + sG; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb; }
      else if (fr >= fb) { a = sR; c = sR + sB; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg; }
      else { a = sB; c = sR + sB; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg; }
    } else if (fb > fg) { a = sB; c = sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr; }
    else if (fb > fr) { a = sG; c = sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr; }
    else { a = sG; c = sR + sG; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb; }
    const oa = o + a, oc = o + c, od = o + sAll;
    const R = t[o] * w0 + t[oa] * w1 + t[oc] * w2 + t[od] * w3;
    const G = t[o + 1] * w0 + t[oa + 1] * w1 + t[oc + 1] * w2 + t[od + 1] * w3;
    const B = t[o + 2] * w0 + t[oa + 2] * w1 + t[oc + 2] * w2 + t[od + 2] * w3;
    // Uint8ClampedArray clamps and rounds on store.
    if (k === 1) {
      pixels[p] = R;
      pixels[p + 1] = G;
      pixels[p + 2] = B;
    } else {
      pixels[p] = r + k * (R - r);
      pixels[p + 1] = g + k * (G - g);
      pixels[p + 2] = b + k * (B - b);
    }
  }
  return pixels;
}
