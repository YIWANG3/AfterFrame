#!/usr/bin/env node
// Build the camera mockups in frame-mockups/ from screen annotations.
//
//   node scripts/build-frame-mockups.mjs <screens.json> [--only <id,id,...>]
//
// screens.json comes from the annotation page (a person marks each camera's
// display on its product shot): per camera the source file, where the display
// is (fractions of the picture), its corner radius and the angle that stands
// the picture straight. For each camera this script
//   1. turns the picture upright (the annotation's angle, about its centre),
//   2. cuts the white studio background away (alpha, with the white fringe
//      taken out of the edge pixels),
//   3. punches the display out, so a photo drawn underneath shows through,
//   4. trims to the camera and writes images/<id>.webp,
// and writes mockups.json: the display rect as fractions of that image, which
// EXIF models each camera stands for, and where the picture came from.
//
// The source pictures are not in the repository (see TRADEMARKS.md); the
// script needs the files screens.json points at.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "frame-mockups");
const MAX_SIDE = 1600;

// The annotation's model label → the mockup. `match`: EXIF Model strings (and
// common spellings) this camera stands for, compared without case, spaces or
// punctuation and with the maker's name dropped. `brandDefault`: the camera a
// photo from this maker gets when its own model has no mockup. `whiteMin`: how
// light a pixel must be to count as studio background (222 by default).
const CAMERAS = {
  "907X & CFV 100C": { id: "hasselblad-907x", brand: "hasselblad", name: "Hasselblad 907X & CFV 100C", match: ["CFV 100C/907X", "CFV 100C", "907X", "CFV II 50C/907X", "CFV II 50C", "CFV 50C/907X"], brandDefault: true },
  "X2D II 100C": { id: "hasselblad-x2d-ii", brand: "hasselblad", name: "Hasselblad X2D II 100C", match: ["X2D II 100C"] },
  "X2D 100C": { id: "hasselblad-x2d", brand: "hasselblad", name: "Hasselblad X2D 100C", match: ["X2D 100C"] },
  "X1D II 50C": { id: "hasselblad-x1d-ii", brand: "hasselblad", name: "Hasselblad X1D II 50C", match: ["X1D II 50C", "X1D-50c", "X1D 50c"] },

  "M11-P": { id: "leica-m11-p", brand: "leica", name: "Leica M11-P", match: ["M11-P", "M11", "M11 Monochrom", "M11-P Safari"], brandDefault: true },
  "M EV1": { id: "leica-m-ev1", brand: "leica", name: "Leica M EV1", match: ["M EV1"] },
  "M10 / M10-R / M10-P": { id: "leica-m10", brand: "leica", name: "Leica M10", match: ["M10", "M10-R", "M10-P", "M10 Monochrom", "M10-R Black Paint"] },
  "Q3": { id: "leica-q3", brand: "leica", name: "Leica Q3", match: ["Q3", "Q3 43"] },
  "Q2": { id: "leica-q2", brand: "leica", name: "Leica Q2", match: ["Q2", "Q2 Monochrom"] },
  "SL3 / SL3-S": { id: "leica-sl3", brand: "leica", name: "Leica SL3", match: ["SL3", "SL3-S"] },
  "D-Lux 8": { id: "leica-d-lux-8", brand: "leica", name: "Leica D-Lux 8", match: ["D-Lux 8"] },

  "EOS R5 Mark II": { id: "canon-eos-r5-ii", brand: "canon", name: "Canon EOS R5 Mark II", match: ["EOS R5 Mark II", "EOS R5m2"] },
  "EOS R5": { id: "canon-eos-r5", brand: "canon", name: "Canon EOS R5", match: ["EOS R5"] },
  "EOS R6 Mark III": { id: "canon-eos-r6-iii", brand: "canon", name: "Canon EOS R6 Mark III", match: ["EOS R6 Mark III", "EOS R6m3"], brandDefault: true },
  "EOS R6 Mark II": { id: "canon-eos-r6-ii", brand: "canon", name: "Canon EOS R6 Mark II", match: ["EOS R6 Mark II", "EOS R6m2"] },
  "EOS R6": { id: "canon-eos-r6", brand: "canon", name: "Canon EOS R6", match: ["EOS R6"] },
  "EOS R8": { id: "canon-eos-r8", brand: "canon", name: "Canon EOS R8", match: ["EOS R8"] },
  "EOS R7": { id: "canon-eos-r7", brand: "canon", name: "Canon EOS R7", match: ["EOS R7"] },
  "EOS R10": { id: "canon-eos-r10", brand: "canon", name: "Canon EOS R10", match: ["EOS R10"] },
  "EOS R50": { id: "canon-eos-r50", brand: "canon", name: "Canon EOS R50", match: ["EOS R50"] },
  "EOS R100": { id: "canon-eos-r100", brand: "canon", name: "Canon EOS R100", match: ["EOS R100"] },
  "EOS RP": { id: "canon-eos-rp", brand: "canon", name: "Canon EOS RP", match: ["EOS RP"] },
  "EOS R1": { id: "canon-eos-r1", brand: "canon", name: "Canon EOS R1", match: ["EOS R1"] },
  "EOS R3": { id: "canon-eos-r3", brand: "canon", name: "Canon EOS R3", match: ["EOS R3"] },
  "EOS 5D Mark IV": { id: "canon-eos-5d-iv", brand: "canon", name: "Canon EOS 5D Mark IV", match: ["EOS 5D Mark IV"] },
  "PowerShot G7 X Mark III": { id: "canon-g7-x-iii", brand: "canon", name: "Canon PowerShot G7 X Mark III", match: ["PowerShot G7 X Mark III"] },
  "PowerShot V1": { id: "canon-powershot-v1", brand: "canon", name: "Canon PowerShot V1", match: ["PowerShot V1"] },

  "Z f": { id: "nikon-z-f", brand: "nikon", name: "Nikon Z f", match: ["Z f"], brandDefault: true },
  "Z fc": { id: "nikon-z-fc", brand: "nikon", name: "Nikon Z fc", match: ["Z fc"] },
  "Z6III": { id: "nikon-z6-iii", brand: "nikon", name: "Nikon Z6III", match: ["Z6_3", "Z 6_3", "Z6III"] },
  "Z6II / Z7II": { id: "nikon-z6-ii", brand: "nikon", name: "Nikon Z6II", match: ["Z 6_2", "Z 7_2", "Z6II", "Z7II", "Z 6", "Z 7"] },
  "Z8": { id: "nikon-z8", brand: "nikon", name: "Nikon Z8", match: ["Z 8", "Z8"] },
  "Z9": { id: "nikon-z9", brand: "nikon", name: "Nikon Z9", match: ["Z 9", "Z9"] },
  "Z5II": { id: "nikon-z5-ii", brand: "nikon", name: "Nikon Z5II", match: ["Z5_2", "Z 5_2", "Z5II", "Z 5"] },
  "Z50II": { id: "nikon-z50-ii", brand: "nikon", name: "Nikon Z50II", match: ["Z50_2", "Z 50_2", "Z50II", "Z 50"] },
  "Z30": { id: "nikon-z30", brand: "nikon", name: "Nikon Z30", match: ["Z 30", "Z30"] },
  "D850": { id: "nikon-d850", brand: "nikon", name: "Nikon D850", match: ["D850"] },

  "α7 V": { id: "sony-a7-v", brand: "sony", name: "Sony α7 V", match: ["ILCE-7M5"] },
  "α7 IV": { id: "sony-a7-iv", brand: "sony", name: "Sony α7 IV", match: ["ILCE-7M4"], brandDefault: true },
  "α7 III": { id: "sony-a7-iii", brand: "sony", name: "Sony α7 III", match: ["ILCE-7M3"] },
  "α7C II / α7CR": { id: "sony-a7c-ii", brand: "sony", name: "Sony α7C II", match: ["ILCE-7CM2", "ILCE-7CR", "ILCE-7C"] },
  "α7R V": { id: "sony-a7r-v", brand: "sony", name: "Sony α7R V", match: ["ILCE-7RM5"] },
  "α1 II / α9 III": { id: "sony-a1-ii", brand: "sony", name: "Sony α1 II", match: ["ILCE-1M2", "ILCE-9M3"] },
  "α6700": { id: "sony-a6700", brand: "sony", name: "Sony α6700", match: ["ILCE-6700"] },
  "ZV-E10 II": { id: "sony-zv-e10-ii", brand: "sony", name: "Sony ZV-E10 II", match: ["ZV-E10M2"] },
  "RX100 VII": { id: "sony-rx100-vii", brand: "sony", name: "Sony RX100 VII", match: ["DSC-RX100M7"] },
  "ZV-1 II": { id: "sony-zv-1-ii", brand: "sony", name: "Sony ZV-1 II", match: ["ZV-1M2"] },
  "FX3 / FX3A / FX30": { id: "sony-fx3", brand: "sony", name: "Sony FX3", match: ["ILME-FX3", "ILME-FX3A", "ILME-FX30"] },
  "FX5": { id: "sony-fx5", brand: "sony", name: "Sony FX5", match: ["ILME-FX5"] },

  "LUMIX S5II / S5IIX": { id: "panasonic-s5-ii", brand: "panasonic", name: "Panasonic LUMIX S5II", match: ["DC-S5M2", "DC-S5M2X"], brandDefault: true },
  "LUMIX S9": { id: "panasonic-s9", brand: "panasonic", name: "Panasonic LUMIX S9", match: ["DC-S9"] },
  "LUMIX G9II": { id: "panasonic-g9-ii", brand: "panasonic", name: "Panasonic LUMIX G9II", match: ["DC-G9M2"] },
  "LUMIX S1II / S1RII": { id: "panasonic-s1-ii", brand: "panasonic", name: "Panasonic LUMIX S1II", match: ["DC-S1M2", "DC-S1RM2", "DC-S1M2ES"] },
  "LUMIX LX100 II": { id: "panasonic-lx100-ii", brand: "panasonic", name: "Panasonic LUMIX LX100 II", match: ["DC-LX100M2"] },

  "X100VI": { id: "fujifilm-x100vi", brand: "fujifilm", name: "Fujifilm X100VI", match: ["X100VI"] },
  "X-T5": { id: "fujifilm-x-t5", brand: "fujifilm", name: "Fujifilm X-T5", match: ["X-T5"], brandDefault: true },
  "X-T50": { id: "fujifilm-x-t50", brand: "fujifilm", name: "Fujifilm X-T50", match: ["X-T50"] },
  "X-E5": { id: "fujifilm-x-e5", brand: "fujifilm", name: "Fujifilm X-E5", match: ["X-E5"] },
  "X-M5": { id: "fujifilm-x-m5", brand: "fujifilm", name: "Fujifilm X-M5", match: ["X-M5"] },
  "X-S20": { id: "fujifilm-x-s20", brand: "fujifilm", name: "Fujifilm X-S20", match: ["X-S20"] },
  "X-T30 III / X-T30 II": { id: "fujifilm-x-t30-iii", brand: "fujifilm", name: "Fujifilm X-T30 III", match: ["X-T30 III", "X-T30 II", "X-T30"] },
  "X-H2 / X-H2S": { id: "fujifilm-x-h2", brand: "fujifilm", name: "Fujifilm X-H2", match: ["X-H2", "X-H2S"] },
  "X-Pro3": { id: "fujifilm-x-pro3", brand: "fujifilm", name: "Fujifilm X-Pro3", match: ["X-Pro3"] },
  "X-T4": { id: "fujifilm-x-t4", brand: "fujifilm", name: "Fujifilm X-T4", match: ["X-T4"] },
  "GFX100S II": { id: "fujifilm-gfx100s-ii", brand: "fujifilm", name: "Fujifilm GFX100S II", match: ["GFX100S II", "GFX100S"] },
  "GFX100RF": { id: "fujifilm-gfx100rf", brand: "fujifilm", name: "Fujifilm GFX100RF", match: ["GFX100RF"] },
  "GFX100 II": { id: "fujifilm-gfx100-ii", brand: "fujifilm", name: "Fujifilm GFX100 II", match: ["GFX100 II"] },
  "X half": { id: "fujifilm-x-half", brand: "fujifilm", name: "Fujifilm X half", match: ["X half", "X-HF1"] },

  "Ricoh GR IV / GR IV Monochrome": { id: "ricoh-gr-iv", brand: "ricoh", name: "Ricoh GR IV", match: ["GR IV", "GR IV Monochrome", "GR IV HDF"], brandDefault: true },
  "Ricoh GR III / GR IIIx": { id: "ricoh-gr-iii", brand: "ricoh", name: "Ricoh GR III", match: ["GR III", "GR IIIx", "GR III HDF", "GR IIIx HDF"] },
  "OM System OM-1 Mark II": { id: "om-system-om-1-ii", brand: "om", name: "OM System OM-1 Mark II", match: ["OM-1MarkII", "OM-1 Mark II", "OM-1"], brandDefault: true },
  "OM System OM-5 / E-M5 III": { id: "om-system-om-5", brand: "om", name: "OM System OM-5", match: ["OM-5", "E-M5MarkIII", "E-M5 Mark III"] },
  // A white aluminium body: only true white counts as studio background.
  "Sigma BF": { id: "sigma-bf", brand: "sigma", name: "Sigma BF", match: ["BF"], whiteMin: 250 },
  "Sigma fp / fp L": { id: "sigma-fp", brand: "sigma", name: "Sigma fp", match: ["fp", "fp L"], brandDefault: true },
  "Pentax K-1 Mark II": { id: "pentax-k-1-ii", brand: "pentax", name: "Pentax K-1 Mark II", match: ["K-1 Mark II", "K-1"], brandDefault: true },
};

// A photo with no camera this table knows: the flat 907X for a landscape
// photo, the M11-P turned on its side for a portrait one.
const GENERIC = { landscape: "hasselblad-907x", portrait: "leica-m11-p" };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Bilinear sample of an RGB buffer; white outside. */
function sample(data, W, H, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const xx = x0 + dx, yy = y0 + dy;
      v += w * (xx < 0 || yy < 0 || xx >= W || yy >= H ? 255 : data[(yy * W + xx) * 3 + c]);
    }
    out[c] = v;
  }
}

/** The picture turned `deg` clockwise about its centre, same size (as the
 *  annotation page shows it: a CSS rotate on the image). */
function turn(data, W, H, deg) {
  if (!deg) return data;
  const out = Buffer.alloc(W * H * 3);
  const a = (-deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = W / 2, cy = H / 2, px = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Inverse map: output pixel centre → source point.
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      sample(data, W, H, cx + dx * cos - dy * sin - 0.5, cy + dx * sin + dy * cos - 0.5, px);
      const i = (y * W + x) * 3;
      out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2];
    }
  }
  return out;
}

/** 1 for the studio background: near-white pixels reached from the border. */
function backgroundMask(data, W, H, whiteMin) {
  const bg = new Uint8Array(W * H);
  const white = (i) => {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn > whiteMin && mx - mn < 28;
  };
  const stack = [];
  const push = (i) => { if (!bg[i] && white(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  return bg;
}

/** RGBA with the background cut out. Pixels on the edge (either side of it)
 *  get an alpha from how far they are from white, and their colour with that
 *  white taken back out, so no light fringe shows on a dark backdrop. */
function cutOut(data, W, H, bg) {
  const rgba = Buffer.alloc(W * H * 4);
  const edge = (i) => {
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (bg[yy * W + xx] !== bg[i]) return true;
    }
    return false;
  };
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    let a = bg[i] ? 0 : 1;
    if (edge(i)) a = clamp((255 - Math.min(r, g, b)) / 64, 0, 1);
    const o = i * 4;
    if (a > 0) {
      // Observed = a·colour + (1 − a)·white → colour.
      rgba[o] = clamp(Math.round((r - (1 - a) * 255) / a), 0, 255);
      rgba[o + 1] = clamp(Math.round((g - (1 - a) * 255) / a), 0, 255);
      rgba[o + 2] = clamp(Math.round((b - (1 - a) * 255) / a), 0, 255);
    }
    rgba[o + 3] = Math.round(a * 255);
  }
  return rgba;
}

/** How much of pixel (x, y) a rounded rect covers, 0..1 (4×4 supersampled). */
function coverage(x, y, r) {
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
    if (px < r.x0 || px > r.x1 || py < r.y0 || py > r.y1) continue;
    const cx = clamp(px, r.x0 + r.rad, r.x1 - r.rad), cy = clamp(py, r.y0 + r.rad, r.y1 - r.rad);
    if ((px - cx) ** 2 + (py - cy) ** 2 <= r.rad * r.rad) n++;
  }
  return n / 16;
}

/** Punch the display out: alpha down by how much of each pixel it covers. */
function punchScreen(rgba, W, H, rect) {
  const x0 = Math.floor(rect.x0), x1 = Math.ceil(rect.x1), y0 = Math.floor(rect.y0), y1 = Math.ceil(rect.y1);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const c = coverage(x, y, rect);
      if (c > 0) rgba[(y * W + x) * 4 + 3] = Math.round(rgba[(y * W + x) * 4 + 3] * (1 - c));
    }
  }
}

function alphaBounds(rgba, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (rgba[(y * W + x) * 4 + 3] > 4) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

async function buildOne(cam, entry) {
  const { data, info } = await sharp(cam.file).rotate().flatten({ background: "#ffffff" }).removeAlpha()
    .toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  if (cam.size && (cam.size[0] !== W || cam.size[1] !== H)) {
    throw new Error(`${entry.id}: picture is ${W}×${H}, the annotation says ${cam.size.join("×")}`);
  }
  const upright = turn(data, W, H, cam.screen.angle || 0);
  const bg = backgroundMask(upright, W, H, entry.whiteMin ?? 222);
  const rgba = cutOut(upright, W, H, bg);
  const s = cam.screen;
  const screen = { x0: s.x * W, y0: s.y * H, x1: (s.x + s.w) * W, y1: (s.y + s.h) * H };
  screen.rad = (s.radius || 0) * Math.min(screen.x1 - screen.x0, screen.y1 - screen.y0);
  punchScreen(rgba, W, H, screen);

  const b = alphaBounds(rgba, W, H);
  const m = 2;
  const left = Math.max(0, b.x0 - m), top = Math.max(0, b.y0 - m);
  const bw = Math.min(W, b.x1 + 1 + m) - left, bh = Math.min(H, b.y1 + 1 + m) - top;
  const scale = Math.min(1, MAX_SIDE / Math.max(bw, bh));
  const ow = Math.round(bw * scale), oh = Math.round(bh * scale);
  let img = sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract({ left, top, width: bw, height: bh });
  if (scale < 1) img = img.resize(ow, oh, { kernel: "lanczos3" });
  const file = `images/${entry.id}.webp`;
  await img.webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(path.join(OUT, file));

  return {
    id: entry.id, brand: entry.brand, name: entry.name, match: entry.match,
    ...(entry.brandDefault ? { brandDefault: true } : {}),
    file, size: [ow, oh],
    // The display, as fractions of the image; radius as a fraction of its short side.
    screen: {
      x: r5((screen.x0 - left) / bw), y: r5((screen.y0 - top) / bh),
      w: r5((screen.x1 - screen.x0) / bw), h: r5((screen.y1 - screen.y0) / bh),
      radius: r5(s.radius || 0),
    },
    source: cam.source || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const screensFile = args.find((a) => !a.startsWith("--"));
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(",")) : null;
  if (!screensFile) {
    console.error("usage: node scripts/build-frame-mockups.mjs <screens.json> [--only <id,...>]");
    process.exit(1);
  }
  const screens = JSON.parse(await fs.readFile(screensFile, "utf8"));
  await fs.mkdir(path.join(OUT, "images"), { recursive: true });
  const manifestFile = path.join(OUT, "mockups.json");
  const previous = await fs.readFile(manifestFile, "utf8").then(JSON.parse).catch(() => ({ mockups: [] }));
  const byId = new Map(previous.mockups.map((m) => [m.id, m]));

  for (const cam of screens.cameras) {
    if (cam.state === "skip" || !cam.screen) continue;
    const entry = CAMERAS[cam.model];
    if (!entry) throw new Error(`no entry for "${cam.model}" in CAMERAS`);
    if (only && !only.has(entry.id)) continue;
    const built = await buildOne(cam, entry);
    byId.set(entry.id, built);
    console.log(`${entry.id.padEnd(24)} ${built.size.join("×").padEnd(10)} screen ${Math.round(built.screen.w * built.size[0])}×${Math.round(built.screen.h * built.size[1])}`);
  }

  // Table order: brand by brand, as CAMERAS lists them.
  const order = Object.values(CAMERAS).map((c) => c.id);
  const mockups = [...byId.values()].filter((m) => order.includes(m.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const manifest = {
    version: 1,
    about: "Camera mockups for the frame tool. Built by scripts/build-frame-mockups.mjs; see TRADEMARKS.md.",
    generic: GENERIC,
    mockups,
  };
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${mockups.length} mockups → ${path.relative(process.cwd(), manifestFile)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
