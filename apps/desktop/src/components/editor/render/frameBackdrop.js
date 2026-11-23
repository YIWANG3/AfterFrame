// The frame's canvas beyond a flat colour: a gradient taken from the photo's
// own colours (the Instagram-story look) and the photo blurred to fill the
// canvas. Also the photo's own rounded corners and drop shadow. One module
// for the live preview, the export and template thumbnails, so they can't
// drift apart.
//
// Sizes: blur, corner radius and shadow are fractions of the CONTENT's short
// edge (the cropped photo), like the margins, so a preview at screen size and
// the export at full resolution look the same.

import { angledLinearGradient } from "./canvasHelpers";

export const PHOTO_BG_MODES = ["palette", "blur"];
export const DEFAULT_BG_BLUR = 50;
// 100 on the blur slider = a blur radius of 8% of the short edge.
const BLUR_FRACTION_AT_100 = 0.08;
// 100 on the corner slider = a radius of 10% of the short edge.
const RADIUS_FRACTION_AT_100 = 0.1;

export function bgUsesPhoto(bg) {
  return PHOTO_BG_MODES.includes(bg?.mode);
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ── Colours from the photo ──────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const HUE_BUCKETS = 18;

/** The hues in rows y0..y1 of an RGBA buffer `width` wide, strongest first:
 *  saturated, mid-light pixels weigh most, and neighbouring hues count too, so
 *  a hue split across a bucket edge still wins. Each has its bucket `k`, its
 *  `weight` and its average `rgb`; `average` is the region's plain average and
 *  `count` how many pixels it has. */
function regionHues(data, width, y0, y1) {
  const B = HUE_BUCKETS;
  const buckets = Array.from({ length: B }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let ar = 0, ag = 0, ab = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      ar += r; ag += g; ab += b; n++;
      const [h, s, l] = rgbToHsl(r, g, b);
      const wt = s * (1 - Math.abs(l - 0.5) * 1.4);
      if (wt <= 0.02) continue;
      const k = Math.floor(h * B) % B;
      const bk = buckets[k];
      bk.w += wt; bk.r += r * wt; bk.g += g * wt; bk.b += b * wt;
    }
  }
  const hues = [];
  for (let k = 0; k < B; k++) {
    const bk = buckets[k];
    if (!bk.w) continue;
    const weight = bk.w + 0.5 * (buckets[(k + 1) % B].w + buckets[(k + B - 1) % B].w);
    hues.push({ k, weight, rgb: [bk.r / bk.w, bk.g / bk.w, bk.b / bk.w] });
  }
  hues.sort((a, b) => b.weight - a.weight);
  return { hues, average: n ? [ar / n, ag / n, ab / n] : [128, 128, 128], count: n };
}

/** A region's colour: its strongest hue, or its plain average when it is grey. */
function regionColor(region) {
  const best = region.hues[0];
  return best && best.weight >= region.count * 0.03 ? best.rgb : region.average;
}

/** The colour that dominates rows y0..y1 of an RGBA buffer `width` wide: the
 *  strongest hue (saturated, mid-light pixels weigh most), or the plain
 *  average when the region is grey. */
export function dominantColor(data, width, y0, y1) {
  return regionColor(regionHues(data, width, y0, y1));
}

function vividHsl([r, g, b]) {
  const [h, s0, l0] = rgbToHsl(r, g, b);
  const s = s0 < 0.06 ? s0 : Math.min(0.9, s0 * 1.35 + 0.12);
  const l = Math.min(0.68, Math.max(0.32, l0));
  return [h, s, l];
}

/** A dominant colour made a little livelier: more saturation, lightness kept
 *  away from black and white. Greys stay grey. */
export function vividHex(rgb) {
  return hslToHex(...vividHsl(rgb));
}

/** CIE76 colour difference between two sRGB colours (about 2.3 is the
 *  smallest a person notices; two ends below MIN_PALETTE_DELTA read as one
 *  flat colour). */
export function colorDelta(a, b) {
  const lab = ([r, g, bl]) => {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = [lin(r), lin(g), lin(bl)];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const MIN_PALETTE_DELTA = 20;
// Two other hues may stand in for the strongest ones only when they are at
// least this far apart (buckets of 20°) and each has this share of its
// region's strongest weight, so a small accent never takes over an end.
const PAIR_MIN_BUCKETS = 3;
const PAIR_MIN_SHARE = 0.35;
// A one-hue photo's two ends: this far apart in lightness.
const LIGHTNESS_SPREAD = 0.22;

const hslToRgb = (h, s, l) => {
  const n = parseInt(hslToHex(h, s, l).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Two hues, one from each region, at least PAIR_MIN_BUCKETS apart, each
 *  strong in its own region; the pair strongest together, or null. */
function distinctPair(top, bottom) {
  const strong = (region) => region.hues.filter((h) => h.weight >= region.hues[0].weight * PAIR_MIN_SHARE);
  const topMax = top.hues[0]?.weight, bottomMax = bottom.hues[0]?.weight;
  if (!topMax || !bottomMax) return null;
  let best = null, bestScore = 0;
  for (const a of strong(top)) {
    for (const b of strong(bottom)) {
      const d = Math.abs(a.k - b.k);
      if (Math.min(d, HUE_BUCKETS - d) < PAIR_MIN_BUCKETS) continue;
      const score = a.weight / topMax + b.weight / bottomMax;
      if (score > bestScore) { bestScore = score; best = [a.rgb, b.rgb]; }
    }
  }
  return best;
}

/** { top, bottom } colours from an N×N RGBA sample of the photo: the
 *  strongest colour of its top 40% and of its bottom 40%. When those two come
 *  out about the same (a framed painting on a wall, a photo that is blue all
 *  over), the ends still differ: two other clearly different colours of the
 *  photo when it has them, else its one colour lighter at one end and darker
 *  at the other, the lighter where the photo is lighter. */
export function paletteFromPixels(data, size) {
  const top = regionHues(data, size, 0, Math.round(size * 0.4));
  const bottom = regionHues(data, size, Math.round(size * 0.6), size);
  let a = regionColor(top), b = regionColor(bottom);
  const close = () => colorDelta(hslToRgb(...vividHsl(a)), hslToRgb(...vividHsl(b))) < MIN_PALETTE_DELTA;
  if (close()) [a, b] = distinctPair(top, bottom) || [a, b];
  const t = vividHsl(a), u = vividHsl(b);
  if (close()) {
    const topLighter = rgbToHsl(...top.average)[2] >= rgbToHsl(...bottom.average)[2];
    const mid = Math.min(0.62, Math.max(0.34, (t[2] + u[2]) / 2));
    t[2] = mid + (topLighter ? 1 : -1) * LIGHTNESS_SPREAD / 2;
    u[2] = mid + (topLighter ? -1 : 1) * LIGHTNESS_SPREAD / 2;
  }
  return { top: hslToHex(...t), bottom: hslToHex(...u) };
}

const paletteCache = new WeakMap();
const PALETTE_SAMPLE = 28;

/** The two colours the photo-colour gradient runs between, for `source`
 *  (an image or canvas) cut to `srcRect` (source pixels; whole source when
 *  omitted). Cached per source + rect. */
export function photoPalette(source, srcRect) {
  if (!source) return { top: "#888888", bottom: "#444444" };
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const r = srcRect || { x: 0, y: 0, width: sw, height: sh };
  const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  let byRect = paletteCache.get(source);
  if (!byRect) { byRect = new Map(); paletteCache.set(source, byRect); }
  if (byRect.has(key)) return byRect.get(key);
  const c = makeCanvas(PALETTE_SAMPLE, PALETTE_SAMPLE);
  const x = c.getContext("2d", { willReadFrequently: true });
  let palette;
  try {
    x.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE);
    palette = paletteFromPixels(x.getImageData(0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE).data, PALETTE_SAMPLE);
  } catch {
    palette = { top: "#888888", bottom: "#444444" };
  }
  byRect.set(key, palette);
  return palette;
}

/** The photo-colour gradient as a regular gradient (to hand the user an
 *  editable copy of it). */
export function paletteGradient(palette, angle = 180) {
  return { from: palette.top, to: palette.bottom, fromOpacity: 1, toOpacity: 1, angle };
}

// ── The photo, blurred, filling the canvas ─────────────────────────────────

export function bgBlurPx(bg, short) {
  return ((bg?.blur ?? DEFAULT_BG_BLUR) / 100) * BLUR_FRACTION_AT_100 * short;
}

/** Cover W×H with `source` (cut to srcRect) blurred by blurPx. Blurs a small
 *  copy and scales it up, so a big export costs about what the preview does;
 *  the copy carries a margin so the blur never pulls in a transparent edge. */
export function drawBlurredCover(ctx, source, srcRect, W, H, blurPx, { brightness = 1, saturate = 1 } = {}) {
  if (!source) return;
  const radius = Math.max(0, blurPx);
  const k = radius > 10 ? 10 / radius : 1;
  const sw = Math.max(4, Math.round(W * k));
  const sh = Math.max(4, Math.round(H * k));
  const m = Math.ceil(radius * k * 3) + 1;
  const big = makeCanvas(sw + 2 * m, sh + 2 * m);
  const bx = big.getContext("2d");
  bx.imageSmoothingQuality = "high";
  const r = srcRect || { x: 0, y: 0, width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  const s = Math.max(big.width / r.width, big.height / r.height);
  bx.drawImage(source, r.x, r.y, r.width, r.height,
    (big.width - r.width * s) / 2, (big.height - r.height * s) / 2, r.width * s, r.height * s);
  const small = makeCanvas(sw, sh);
  const sx = small.getContext("2d");
  const filters = [];
  if (radius > 0) filters.push(`blur(${radius * k}px)`);
  if (saturate !== 1) filters.push(`saturate(${saturate})`);
  if (brightness !== 1) filters.push(`brightness(${brightness})`);
  if (filters.length) sx.filter = filters.join(" ");
  sx.drawImage(big, -m, -m);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, W, H);
  ctx.restore();
}

// ── Rounded rect geometry ───────────────────────────────────────────────────

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, rad);
  else ctx.rect(x, y, w, h);
}

// ── The photo's corners and shadow ──────────────────────────────────────────

export function photoRadiusPx(photoStyle, short) {
  return ((photoStyle?.radius || 0) / 100) * RADIUS_FRACTION_AT_100 * short;
}

/** Canvas shadow for the photo; null when there is none. CSS box-shadow uses
 *  the same numbers (blur radius = canvas shadowBlur). */
export function photoShadow(photoStyle, short) {
  const k = (photoStyle?.shadow || 0) / 100;
  if (k <= 0) return null;
  return {
    color: `rgba(0,0,0,${(0.2 + 0.45 * k).toFixed(3)})`,
    blur: short * 0.09 * k,
    offsetY: short * 0.025 * k,
  };
}

export function photoStyleActive(photoStyle) {
  return !!(photoStyle && (photoStyle.radius > 0 || photoStyle.shadow > 0));
}

/** The CSS a preview element showing the photo at `short` screen pixels needs. */
export function photoStyleCss(photoStyle, short) {
  const sh = photoShadow(photoStyle, short);
  const r = photoRadiusPx(photoStyle, short);
  return {
    borderRadius: r ? `${r}px` : undefined,
    boxShadow: sh ? `0 ${sh.offsetY}px ${sh.blur}px ${sh.color}` : undefined,
  };
}

/** Draw the photo's shadow (under where the photo goes). */
export function drawPhotoShadow(ctx, rect, photoStyle, short) {
  const sh = photoShadow(photoStyle, short);
  if (!sh) return;
  ctx.save();
  ctx.shadowColor = sh.color;
  ctx.shadowBlur = sh.blur;
  ctx.shadowOffsetY = sh.offsetY;
  ctx.fillStyle = "#000";
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, photoRadiusPx(photoStyle, short));
  ctx.fill();
  ctx.restore();
}

/** Clip ctx to the photo's (rounded) rect. Caller saves/restores. */
export function clipToPhoto(ctx, rect, photoStyle, short) {
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, photoRadiusPx(photoStyle, short));
  ctx.clip();
}

// ── The whole background ────────────────────────────────────────────────────

/**
 * Paint the canvas background into ctx (0,0)-(W,H).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} bg            canvas.bg
 * @param {object} g
 * @param {number} g.W
 * @param {number} g.H
 * @param {CanvasImageSource} [g.source]   the photo (for photo-based modes)
 * @param {object} [g.srcRect]             the content's rect in `source`
 * @param {number} g.short                 the content's short edge, ctx px
 */
export function drawCanvasBackground(ctx, bg, { W, H, source, srcRect, short }) {
  const mode = bg?.mode;
  if (mode === "palette" && source) {
    const p = photoPalette(source, srcRect);
    ctx.fillStyle = angledLinearGradient(ctx, paletteGradient(p, bg.angle ?? 180), W, H);
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (mode === "blur" && source) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    drawBlurredCover(ctx, source, srcRect, W, H, bgBlurPx(bg, short), { brightness: 0.94 });
    return;
  }
  ctx.fillStyle = bg?.mode === "gradient" && bg.gradient
    ? angledLinearGradient(ctx, bg.gradient, W, H, { fromDefault: "#ffffff", toDefault: "#000000" })
    : bg?.color || "#ffffff";
  ctx.fillRect(0, 0, W, H);
}

// ── A text layer's background box ───────────────────────────────────────────

/** Corner radius of a text background box: bgRadius is 0..100 % of half the
 *  short side (100 = a pill), square by default. */
export function textBgRadius(layer, w, h) {
  const pct = layer.bgRadius ?? 0;
  return (Math.max(0, Math.min(100, pct)) / 100) * (Math.min(w, h) / 2);
}
