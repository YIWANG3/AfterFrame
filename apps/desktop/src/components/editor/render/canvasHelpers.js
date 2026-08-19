// Pure canvas / image helpers used by the editor render + export pipeline.
// No React, no closures — all inputs are passed explicitly.

import { fileName } from "../../../utils/format";

const PREVIEW_MAX_EDGE = 2200;

export function hexToRgba(hex, alpha = 1) {
  const h = String(hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Parse a CSS color (#rgb / #rrggbb / #rrggbbaa / rgb() / rgba()) into
// { hex, opacity }. Frame templates declare their scrim stops as
// "rgba(0,0,0,0.5)" strings; the editor model wants hex + a separate 0-1 alpha.
export function parseCssColor(value, fallbackOpacity = 1) {
  const s = String(value ?? "").trim();
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const c = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
    return {
      hex: `#${c(m[1])}${c(m[2])}${c(m[3])}`,
      opacity: m[4] === undefined ? fallbackOpacity : Math.max(0, Math.min(1, Number(m[4]))),
    };
  }
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const [, r, g, b] = s;
    return { hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase(), opacity: fallbackOpacity };
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s.toLowerCase(), opacity: fallbackOpacity };
  if (/^#[0-9a-f]{8}$/i.test(s)) return { hex: s.slice(0, 7).toLowerCase(), opacity: parseInt(s.slice(7, 9), 16) / 255 };
  return { hex: "#000000", opacity: fallbackOpacity };
}

// ── Multi-stop gradients ────────────────────────────────────────────────────
// A gradient is { angle, stops: [{ pos: 0..1, color: "#hex", opacity: 0..1 }] }.
// The older two-stop shape { from, fromOpacity, to, toOpacity, angle } is still
// accepted everywhere (text layers only ever write that shape); when both are
// present `stops` wins. gradientStops() is the ONE place that resolves it, so
// canvas and CSS renderers can't disagree about what a gradient means.
const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export function gradientStops(g, opts = {}) {
  const {
    fromDefault = "#ffffff", toDefault = "#000000",
    fromOpacityDefault = 1, toOpacityDefault = 1,
  } = opts;
  if (Array.isArray(g?.stops) && g.stops.length >= 2) {
    return g.stops
      .map((s, i) => ({
        pos: clamp01(s.pos ?? (i / (g.stops.length - 1))),
        color: s.color || "#000000",
        opacity: s.opacity == null ? 1 : clamp01(s.opacity),
      }))
      .sort((a, b) => a.pos - b.pos);
  }
  return [
    { pos: 0, color: g?.from || fromDefault, opacity: g?.fromOpacity ?? fromOpacityDefault },
    { pos: 1, color: g?.to || toDefault, opacity: g?.toOpacity ?? toOpacityDefault },
  ];
}

// Build a gradient value from an explicit stops array. Keeps the two-stop
// fields (from/to) in sync with the outermost stops so consumers that only
// read the legacy shape (text-layer field mapping, equality checks) still see
// a coherent value.
export function gradientWithStops(g, stops) {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    ...(g || {}),
    stops: sorted,
    from: first?.color, fromOpacity: first?.opacity,
    to: last?.color, toOpacity: last?.opacity,
  };
}

// Color at position `t` along the stops (linear interpolation) — used when the
// user inserts a stop mid-bar so it starts visually invisible.
export function gradientColorAt(stops, t) {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (!s.length) return { color: "#000000", opacity: 1 };
  if (t <= s[0].pos) return { color: s[0].color, opacity: s[0].opacity };
  if (t >= s[s.length - 1].pos) return { color: s[s.length - 1].color, opacity: s[s.length - 1].opacity };
  let i = 0;
  while (i < s.length - 1 && s[i + 1].pos < t) i++;
  const a = s[i], b = s[i + 1];
  const span = b.pos - a.pos || 1;
  const k = (t - a.pos) / span;
  const ca = parseCssColor(a.color).hex, cb = parseCssColor(b.color).hex;
  const ch = (h, o) => parseInt(h.slice(o, o + 2), 16);
  const mix = (o) => Math.round(ch(ca, o) + (ch(cb, o) - ch(ca, o)) * k).toString(16).padStart(2, "0");
  return { color: `#${mix(1)}${mix(3)}${mix(5)}`, opacity: a.opacity + (b.opacity - a.opacity) * k };
}

export function gradientToCss(g, opts) {
  const stops = gradientStops(g, opts);
  const list = stops.map((s) => `${hexToRgba(s.color, s.opacity)} ${Math.round(s.pos * 10000) / 100}%`).join(", ");
  return `linear-gradient(${g?.angle ?? 180}deg, ${list})`;
}

// Canvas fillStyle for an angled linear gradient across a WxH box — one home
// for the angle→vector math (0deg = up, CSS convention) shared by text fills,
// the border background, overlay layers and the save path. Accepts either
// gradient shape (see gradientStops).
export function angledLinearGradient(ctx, g, W, H, opts) {
  const angle = g?.angle ?? 180;
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  const grad = ctx.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
  for (const s of gradientStops(g, opts)) grad.addColorStop(s.pos, hexToRgba(s.color, s.opacity));
  return grad;
}

// Canvas background (the border area) → a CSS value. Solid color or a linear
// gradient (same angle convention as text gradients: 0deg = up). Shared by
// the live preview and the border-controls swatch so they can't diverge.
export function bgToCss(bg) {
  if (bg?.mode === "gradient" && bg.gradient) {
    return gradientToCss(bg.gradient, { fromDefault: "#ffffff", toDefault: "#000000" });
  }
  return bg?.color || "#ffffff";
}

// ── Overlay / scrim ─────────────────────────────────────────────────────────
// ONE model for "a wash over the photo", whether it came from a frame template
// (edge scrim: { edge, from, to, height } with rgba strings) or from the user's
// own overlay layer. Normalized shape:
//   { mode: "solid"|"gradient", color, opacity: 0-100,
//     gradient: { angle, stops },
//     edge: "bottom"|"top"|"left"|"right",
//     coverage: 0..1 }   // fraction of the photo the wash covers, measured
//                        // from `edge`; 1 = the whole photo
export const OVERLAY_EDGES = ["bottom", "top", "left", "right"];
// A template edge scrim's stops run inner (from) → the edge it hugs (to).
export const OVERLAY_EDGE_ANGLE = { bottom: 180, top: 0, left: 270, right: 90 };
export const OVERLAY_GRADIENT_DEFAULTS = {
  fromDefault: "#000000", toDefault: "#000000", fromOpacityDefault: 0, toOpacityDefault: 0.7,
};

export function isLegacyEdgeScrim(scrim) {
  if (!scrim) return false;
  if (scrim.kind === "edge") return true;
  if (scrim.kind === "fill" || scrim.mode != null || scrim.coverage != null) return false;
  return scrim.height != null || typeof scrim.from === "string" || typeof scrim.to === "string";
}

export function normalizeScrim(scrim) {
  if (!scrim) return null;
  if (isLegacyEdgeScrim(scrim)) {
    const edge = OVERLAY_EDGES.includes(scrim.edge) ? scrim.edge : "bottom";
    const from = parseCssColor(scrim.from ?? "rgba(0,0,0,0)", 0);
    const to = parseCssColor(scrim.to ?? "rgba(0,0,0,0.5)", 0.5);
    return {
      mode: "gradient",
      color: to.hex,
      opacity: 100,
      gradient: gradientWithStops({ angle: OVERLAY_EDGE_ANGLE[edge] }, [
        { pos: 0, color: from.hex, opacity: from.opacity },
        { pos: 1, color: to.hex, opacity: to.opacity },
      ]),
      edge,
      coverage: Math.max(0.01, clamp01(scrim.height ?? 0.3)),
    };
  }
  const edge = OVERLAY_EDGES.includes(scrim.edge) ? scrim.edge : "bottom";
  const coverage = scrim.coverage == null ? 1 : Math.max(0.01, clamp01(scrim.coverage));
  const g = scrim.gradient || {};
  return {
    mode: scrim.mode === "solid" ? "solid" : "gradient",
    color: scrim.color ?? "#000000",
    opacity: scrim.opacity ?? 100,
    gradient: gradientWithStops({ angle: g.angle ?? 180 }, gradientStops(g, OVERLAY_GRADIENT_DEFAULTS)),
    edge,
    coverage,
  };
}

// The sub-rectangle of `rect` an overlay actually covers.
export function scrimCoverageRect(scrim, rect) {
  const s = normalizeScrim(scrim);
  if (!s || s.coverage >= 1) return { ...rect };
  const { x, y, width, height } = rect;
  switch (s.edge) {
    case "top": return { x, y, width, height: height * s.coverage };
    case "left": return { x, y, width: width * s.coverage, height };
    case "right": { const w = width * s.coverage; return { x: x + width - w, y, width: w, height }; }
    default: { const h = height * s.coverage; return { x, y: y + height - h, width, height: h }; }
  }
}

// Wash over the photo — keeps on-photo (overlay preset) text legible
// regardless of how bright the photo is at the edge, or dims the whole image.
// `rect` is the photo's rect on the target canvas. Shared by the frame engine,
// the unified save path and preset generation. Must stay pixel-identical to
// the live preview (scrimToCss + element opacity/geometry in TextCanvas).
export function drawScrim(ctx, scrim, rect) {
  const s = normalizeScrim(scrim);
  if (!s) return;
  const r = scrimCoverageRect(s, rect);
  ctx.save();
  ctx.globalAlpha = (s.opacity ?? 100) / 100;
  ctx.translate(r.x, r.y);
  ctx.fillStyle = s.mode === "gradient"
    ? angledLinearGradient(ctx, s.gradient, r.width, r.height, OVERLAY_GRADIENT_DEFAULTS)
    : s.color;
  ctx.fillRect(0, 0, r.width, r.height);
  ctx.restore();
}

// Scrim → CSS background for the live preview (must match drawScrim's canvas
// output). Pair with `opacity: (scrim.opacity ?? 100)/100` on the element and
// size/position it by scrimCoverageRect().
export function scrimToCss(scrim) {
  const s = normalizeScrim(scrim);
  if (!s) return "transparent";
  return s.mode === "gradient" ? gradientToCss(s.gradient, OVERLAY_GRADIENT_DEFAULTS) : s.color;
}

export function getSourceDimensions(source) {
  return {
    width: Number(source?.naturalWidth || source?.width || 0),
    height: Number(source?.naturalHeight || source?.height || 0),
  };
}

export function releaseCanvasImage(source) {
  if (!source || typeof source.width !== "number") return;
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return;
  source.width = 0;
  source.height = 0;
}

export function buildPreviewSource(image) {
  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(image);
  const maxEdge = Math.max(sourceWidth, sourceHeight);
  const scale = maxEdge > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / maxEdge : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.naturalWidth = width;
  canvas.naturalHeight = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

// Field-resolution alpha mask off the depth field.
// White (alpha 255) where the depth field is < zPosition (text shows through);
// transparent where depth is > zPosition (text is hidden behind nearer pixels).
// `depthCanvas` is the 518×392 grayscale depth field (R=G=B=depth, 0=far, 255=near).
export function buildDepthAlphaMask(depthCanvas, zPosition, feather) {
  const dW = depthCanvas.width;
  const dH = depthCanvas.height;
  const data = depthCanvas.getContext("2d").getImageData(0, 0, dW, dH).data;
  const z = Math.max(0, Math.min(1, zPosition));
  const f = Math.max(0, Math.min(0.5, feather));
  // Clamp the feather window to [0,1] so the ramp doesn't extend past the
  // valid depth range — otherwise pixels at depth 0 (or 1) land in the middle
  // of the ramp and get partial alpha. Must match TextCanvas.getMaskUrl.
  const lo = Math.max(0, z - f / 2);
  const hi = Math.min(1, z + f / 2);
  const small = document.createElement("canvas");
  small.width = dW;
  small.height = dH;
  const sCtx = small.getContext("2d");
  const out = sCtx.createImageData(dW, dH);
  for (let i = 0; i < dW * dH; i++) {
    const d = data[i * 4] / 255;
    let alpha;
    if (d <= lo) alpha = 1;
    else if (d >= hi) alpha = 0;
    else alpha = 1 - (d - lo) / (hi - lo);
    const p = i * 4;
    out.data[p] = 255;
    out.data[p + 1] = 255;
    out.data[p + 2] = 255;
    out.data[p + 3] = Math.round(alpha * 255);
  }
  sCtx.putImageData(out, 0, 0);
  return small;
}

// Full-output depth mask: the photo's depth field is stretched over the given
// canvas size. Valid when the output IS the photo (pad=0, no crop) — padded /
// cropped outputs must map the field onto the photo sub-rect instead (see
// saveImage's composed mask).
export function buildDepthMaskCanvas(depthCanvas, outW, outH, zPosition, feather) {
  const small = buildDepthAlphaMask(depthCanvas, zPosition, feather);
  const big = document.createElement("canvas");
  big.width = outW;
  big.height = outH;
  const bCtx = big.getContext("2d");
  bCtx.imageSmoothingEnabled = true;
  bCtx.imageSmoothingQuality = "high";
  bCtx.drawImage(small, 0, 0, outW, outH);
  return big;
}

export function buildTransformedCanvas(source, width, height, rotationDeg, flipX, flipY) {
  const radians = (rotationDeg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * absCos + height * absSin));
  canvas.height = Math.max(1, Math.round(width * absSin + height * absCos));
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  return canvas;
}

export function deriveEditedFileName(sourcePath, preferredExt = null) {
  const originalName = fileName(sourcePath || "image.jpg");
  const dotIndex = originalName.lastIndexOf(".");
  const stem = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  const originalExt = dotIndex > 0 ? originalName.slice(dotIndex + 1).toLowerCase() : "";
  const ext = preferredExt || (["jpg", "jpeg", "png", "webp"].includes(originalExt) ? originalExt : "jpg");
  return `${stem}_edited.${ext}`;
}

export function replaceFileName(targetPath, nextFileName) {
  if (!targetPath) return nextFileName;
  const slashIndex = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  if (slashIndex < 0) return nextFileName;
  return `${targetPath.slice(0, slashIndex + 1)}${nextFileName}`;
}

export function inferMimeType(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function canvasToBlob(canvas, mimeType) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Failed to encode canvas"));
    }, mimeType, mimeType === "image/png" ? undefined : 0.92);
  });
}
