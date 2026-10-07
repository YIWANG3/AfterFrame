// Prototype: .cube parser + CPU 3D LUT (trilinear and tetrahedral) on 8-bit
// RGBA, as the renderer would run it in a Web Worker. Benchmarks both at
// 24MP / 2200px / 260px and, given Pillow's output for the same input, reports
// the difference. Run from apps/desktop so `sharp` resolves:
//   node ../../docs/prototypes/lut/lut_js_bench.mjs <cube> <photo> [pillow-out.png]
// The table is 16-bit fixed point here (what was measured); the plan keeps it
// Float32 instead, because clamping out-of-range nodes costs up to 17 levels
// on log-conversion LUTs (docs/lut-plan.md).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const sharp = createRequire(process.cwd() + "/")("sharp");

export function parseCube(text) {
  let size = 0;
  const data = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s[0] === "#") continue;
    if (/^[A-Za-z]/.test(s)) {
      const [k, v] = s.split(/\s+/);
      if (k === "LUT_3D_SIZE") size = Number(v);
      continue;
    }
    const p = s.split(/\s+/);
    data.push(+p[0], +p[1], +p[2]);
  }
  if (!size || data.length !== size ** 3 * 3) throw new Error("bad cube");
  const table = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) table[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 65535);
  return { size, table };
}

// Lattice index and fraction per 8-bit input value, shared by both kernels.
function axisTables(size, fracScale) {
  const n1 = size - 1, idx = new Int32Array(256), frac = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const x = (v * n1) / 255;
    let i = Math.floor(x);
    if (i >= n1) i = n1 - 1;
    idx[v] = i;
    frac[v] = fracScale ? Math.round((x - i) * fracScale) : x - i;
  }
  return { idx, frac };
}

export function applyTrilinear(px, { size, table }) {
  const { idx, frac } = axisTables(size, 256);
  const sR = 3, sG = 3 * size, sB = 3 * size * size;
  for (let p = 0; p < px.length; p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const fr = frac[r], fg = frac[g], fb = frac[b];
    const base = idx[r] * sR + idx[g] * sG + idx[b] * sB;
    for (let ch = 0; ch < 3; ch++) {
      const o = base + ch;
      const c00 = table[o] * 256 + (table[o + sR] - table[o]) * fr;
      const c10 = table[o + sG] * 256 + (table[o + sR + sG] - table[o + sG]) * fr;
      const c01 = table[o + sB] * 256 + (table[o + sR + sB] - table[o + sB]) * fr;
      const c11 = table[o + sG + sB] * 256 + (table[o + sR + sG + sB] - table[o + sG + sB]) * fr;
      const c0 = c00 * 256 + (c10 - c00) * fg;
      const c1 = c01 * 256 + (c11 - c01) * fg;
      px[p + ch] = ((c0 * 256 + (c1 - c0) * fb) / 16777216 / 257 + 0.5) | 0;
    }
  }
}

// Four lattice reads per pixel instead of eight: about twice as fast as
// trilinear in JS, and the de-facto default (Resolve, darktable, FFmpeg).
export function applyTetrahedral(px, { size, table }) {
  const { idx, frac } = axisTables(size, 0);
  const sR = 3, sG = 3 * size, sB = 3 * size * size, d = sR + sG + sB, k = 1 / 257;
  for (let p = 0; p < px.length; p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const fr = frac[r], fg = frac[g], fb = frac[b];
    const o = idx[r] * sR + idx[g] * sG + idx[b] * sB;
    let a, c, w0, w1, w2, w3;
    if (fr >= fg) {
      if (fg >= fb) { a = sR; c = sR + sG; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb; }
      else if (fr >= fb) { a = sR; c = sR + sB; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg; }
      else { a = sB; c = sR + sB; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg; }
    } else if (fb > fg) { a = sB; c = sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr; }
    else if (fb > fr) { a = sG; c = sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr; }
    else { a = sG; c = sR + sG; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb; }
    for (let ch = 0; ch < 3; ch++) {
      const q = o + ch;
      // Uint8ClampedArray rounds on store: adding 0.5 here would bias by half a level.
      px[p + ch] = (table[q] * w0 + table[q + a] * w1 + table[q + c] * w2 + table[q + d] * w3) * k;
    }
  }
}

async function main() {
  const [cubePath, photo, pillowOut] = process.argv.slice(2);
  let t = performance.now();
  const lut = parseCube(readFileSync(cubePath, "utf8"));
  console.log(`LUT ${lut.size}^3 parse ${(performance.now() - t).toFixed(0)} ms`);

  for (const [label, w, h] of [["24MP", 6000, 4000], ["2200px", 2200, 1467], ["260px", 260, 173]]) {
    const { data } = await sharp(photo).resize(w, h, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [name, fn] of [["trilinear", applyTrilinear], ["tetrahedral", applyTetrahedral]]) {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const buf = new Uint8ClampedArray(data);
        t = performance.now();
        fn(buf, lut);
        times.push(performance.now() - t);
      }
      console.log(`  ${name.padEnd(11)} ${label.padEnd(6)} ${Math.min(...times).toFixed(1)} ms`);
    }
  }

  // Pillow's Color3DLUT is trilinear: compare like with like.
  if (pillowOut) {
    const meta = await sharp(pillowOut).metadata();
    const buf = new Uint8ClampedArray(await sharp(photo).ensureAlpha().raw().toBuffer());
    const ref = await sharp(pillowOut).ensureAlpha().raw().toBuffer();
    applyTrilinear(buf, lut);
    let max = 0, sum = 0, n = 0;
    for (let p = 0; p < buf.length; p += 4) {
      for (let c = 0; c < 3; c++) { const d = Math.abs(buf[p + c] - ref[p + c]); max = Math.max(max, d); sum += d; n++; }
    }
    console.log(`  trilinear vs Pillow (${meta.width}x${meta.height}): max ${max} mean ${(sum / n).toFixed(3)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
