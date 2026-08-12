// Handwriting sticker matte: turn an AI-generated "black text on white paper"
// image into an alpha silhouette, then colorize it. Ink density maps to
// continuous alpha (alpha = white − luminance), so dry-brush and ink-splatter
// texture survives as real translucency — the reason we generate black-on-white
// instead of green-screen or provider-side transparency.
//
// Structure follows buildDepthAlphaMask (per-pixel ImageData transform) and
// frameLogos.prepareLogo (source-in recolor).

import { angledLinearGradient } from "./canvasHelpers";

// Gemini outputs photographed paper (grey-ish, textured) rather than digital
// white, so the white point is estimated per image: the histogram mode of the
// upper luminance half. Everything closer to paper than `noiseCut` collapses
// to fully transparent, killing paper grain without touching stroke edges.
export function matteHandwriting(image, { noiseCut = 18, gain = 1.1, alphaFloor = 8 } = {}) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sCtx = src.getContext("2d");
  sCtx.drawImage(image, 0, 0, w, h);
  const data = sCtx.getImageData(0, 0, w, h).data;

  const histogram = new Uint32Array(256);
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const v = Math.round(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
    lum[i] = v;
    histogram[v] += 1;
  }
  let white = 255;
  let peak = 0;
  for (let v = 128; v < 256; v++) {
    if (histogram[v] > peak) {
      peak = histogram[v];
      white = v;
    }
  }

  const scale = (255 / Math.max(1, white - noiseCut)) * gain;
  const out = sCtx.createImageData(w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < w * h; i++) {
    const ink = white - lum[i] - noiseCut;
    const alpha = ink <= 0 ? 0 : Math.min(255, Math.round(ink * scale));
    const p = i * 4;
    out.data[p] = 255;
    out.data[p + 1] = 255;
    out.data[p + 2] = 255;
    out.data[p + 3] = alpha;
    if (alpha > alphaFloor) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null; // blank page — nothing to matte

  const pad = Math.round(Math.max(w, h) * 0.015);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  // putImageData with a dirty rect writes the crop window straight into the
  // small canvas — no full-size intermediate needed.
  const cropped = document.createElement("canvas");
  cropped.width = cw;
  cropped.height = ch;
  cropped.getContext("2d").putImageData(out, -minX, -minY, minX, minY, cw, ch);
  return cropped;
}

// fill: { mode: "solid", color } | { mode: "gradient", from, to, angle }.
// Recoloring reuses the cached alpha canvas — no re-matte, so live color
// preview is a cheap fillRect.
export function colorizeHandwriting(alphaCanvas, fill) {
  const w = alphaCanvas.width;
  const h = alphaCanvas.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(alphaCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  // `opacity` (0-100) is the fill's own alpha — matches text fillOpacity.
  ctx.globalAlpha = (fill?.opacity ?? 100) / 100;
  if (fill?.mode === "gradient") {
    ctx.fillStyle = angledLinearGradient(
      ctx,
      {
        angle: fill.angle ?? 90,
        from: fill.from,
        fromOpacity: fill.fromOpacity ?? 1,
        to: fill.to,
        toOpacity: fill.toOpacity ?? 1,
      },
      w,
      h
    );
  } else {
    ctx.fillStyle = fill?.color || "#ffffff";
  }
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return canvas;
}

// Re-coloring a PLACED handwriting sticker re-mattes from the cached raw
// generation; the alpha canvas is memoized per source so slider drags stay
// cheap (one per-pixel pass per image, then colorize-only). Each entry holds a
// full-res canvas, so the cache is bounded FIFO — old entries just re-matte on
// the next edit.
const alphaCache = new Map();
const ALPHA_CACHE_MAX = 8;
export async function handwritingAlphaFromUrl(url) {
  if (alphaCache.has(url)) return alphaCache.get(url);
  const img = await loadHandwritingImage(url);
  const alpha = matteHandwriting(img);
  if (alpha) {
    alphaCache.set(url, alpha);
    if (alphaCache.size > ALPHA_CACHE_MAX) {
      alphaCache.delete(alphaCache.keys().next().value);
    }
  }
  return alpha;
}

export function loadHandwritingImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Pixel access ahead (getImageData) — without this, media:// sources taint
    // the canvas under Electron 43+. Same as useStickerImageCache.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load handwriting image"));
    img.src = url;
  });
}
