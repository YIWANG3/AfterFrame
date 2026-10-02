// Where something added from the Frame tool goes: into the frame, not the
// middle of the photo. A logo (placeLogo) starts at a bar's right end, a line
// of text (placeText: photo info, free text) at its left end, as built-in bars
// have them, and slides along the bar to the first gap that holds it clear of
// what is already there (a brand logo, the EXIF row); a full bar takes the
// spot that overlaps least. A top band is used the same way; with no band,
// the bottom row of the photo.
// Distances are in the content's short edge, like the built-in templates'
// insets (0.05 of 1.5 × the short edge). Everything is in output pixels
// (frameUserTemplates.outputGeometry).

import { LOGO_SCALE, logoHeightFactor } from "./render/frameLogos";

const INSET = 0.075; // of the short edge: the built-in bars' 0.05 × 1.5
const IN_BAND = 0.4 * LOGO_SCALE; // of the band's height, on the marks' scale
const MAX_BAND_WIDTH = 0.45; // of the band's width, for a very wide logo
const CORNER = 0.06 * LOGO_SCALE; // of the short edge, with no band
const MAX_CORNER_WIDTH = 0.3; // of the photo's width
const MIN_BAND = 0.03; // short edges: thinner than this is a border line, not a bar

const TEXT_SIZE_BASIS = 1920; // fontSize is "px at 1920 wide" of the layer basis

/** The rectangles existing layers cover, in output px (overlays excluded:
 *  they are washes, not things a logo would collide with). `layers` are
 *  STORED (full-photo basis); `measure(text, font)` gives a text's width. */
export function layerBoxes(layers, geom, measure) {
  const g = geom;
  const boxes = [];
  for (const layer of layers || []) {
    if (layer.type === "overlay") continue;
    const cx = layer.x * g.fullW - g.cropX + g.left;
    const cy = layer.y * g.fullH - g.cropY + g.top;
    let w;
    let h;
    if (layer.type === "sticker") {
      w = (layer.scale ?? 0.4) * g.fullW;
      h = layer.naturalWidth && layer.naturalHeight ? (w * layer.naturalHeight) / layer.naturalWidth : w;
    } else {
      const fontPx = ((layer.fontSize ?? 0) * g.fullW) / TEXT_SIZE_BASIS;
      const text = String(layer.text ?? "");
      w = measure(text, {
        fontPx, weight: layer.fontWeight ?? 400, italic: !!layer.italic, family: layer.fontFamily, tracking: layer.tracking || 0,
      });
      h = fontPx * (layer.lineHeight || 1.2) * Math.max(1, text.split("\n").length);
    }
    boxes.push({ x: cx - w / 2, y: cy - h / 2, w, h });
  }
  return boxes;
}

const GAP = 0.03; // of the short edge: the clear space kept beside neighbours

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Along a row from one end (`from` +1: left to right, -1: right to left), the
// first centre where a width × height box, with `gap` either side, meets
// nothing already there; if there is none, the centre that overlaps least.
function slide({ from, left, right, cy, width, height, occupied, gap }) {
  const start = from > 0 ? left + width / 2 : right - width / 2;
  const span = Math.max(0, right - left - width);
  const step = Math.max(1, gap / 2);
  let best = null;
  for (let d = 0; d <= span + 0.001; d += step) {
    const cx = start + from * d;
    const box = { x: cx - width / 2 - gap, y: cy - height / 2, w: width + 2 * gap, h: height };
    const area = occupied.reduce((sum, taken) => sum + overlapArea(taken, box), 0);
    if (area === 0) return { cx, cy };
    if (!best || area < best.area) best = { cx, cy, area };
  }
  return best ? { cx: best.cx, cy: best.cy } : { cx: start, cy };
}

/**
 * @param {object} args
 * @param {object} args.geom      outputGeometry() of the photo being edited
 * @param {object} args.pad       canvas margins (short-edge fractions)
 * @param {number} args.aspect    the logo's width / height
 * @param {Array}  [args.occupied] layerBoxes() of what is already there
 * @returns {{ cx: number, cy: number, width: number, height: number, region: "bottom"|"top"|"photo" }}
 */
export function placeLogo({ geom, pad, aspect, occupied = [] }) {
  const g = geom;
  const p = { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) };
  const inset = INSET * g.short;
  const gap = GAP * g.short;

  const edge = p.bottom >= MIN_BAND ? "bottom" : p.top >= MIN_BAND ? "top" : null;
  if (edge) {
    const band = edge === "bottom"
      ? { y: g.top + g.contentH, h: p.bottom * g.short }
      : { y: 0, h: p.top * g.short };
    let height = band.h * IN_BAND;
    let width = height * aspect;
    if (width > g.outW * MAX_BAND_WIDTH) {
      width = g.outW * MAX_BAND_WIDTH;
      height = width / aspect;
    }
    const spot = slide({
      from: -1, left: inset, right: g.outW - inset, cy: band.y + band.h / 2, width, height, occupied, gap,
    });
    return { ...spot, width, height, region: edge };
  }

  let height = CORNER * g.short;
  let width = height * aspect;
  if (width > g.contentW * MAX_CORNER_WIDTH) {
    width = g.contentW * MAX_CORNER_WIDTH;
    height = width / aspect;
  }
  const spot = slide({
    from: -1, left: g.left + inset, right: g.left + g.contentW - inset,
    cy: g.top + g.contentH - inset - height / 2, width, height, occupied, gap,
  });
  return { ...spot, width, height, region: "photo" };
}

const TEXT_IN_BAND = 0.2; // a main line's glyph height, of the band (built-in bars: 0.024 / 0.122)
const TEXT_CORNER = 0.035; // of the short edge, with no band

/**
 * A line of text: from a bar's left end, the first gap that holds it; with no
 * bar, the photo's bottom row from the left.
 * @param {object} args  as placeLogo, plus:
 * @param {(fontPx: number) => number} args.widthAt  the text's width at a font size
 * @param {number} [args.scale=1]  a secondary line (lens, exposure) is smaller
 * @returns {{ cx: number, cy: number, fontPx: number, region: "bottom"|"top"|"photo" }}
 */
export function placeText({ geom, pad, widthAt, occupied = [], scale = 1 }) {
  const g = geom;
  const p = { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) };
  const inset = INSET * g.short;
  const edge = p.bottom >= MIN_BAND ? "bottom" : p.top >= MIN_BAND ? "top" : null;
  const band = edge === "bottom" ? { y: g.top + g.contentH, h: p.bottom * g.short }
    : edge === "top" ? { y: 0, h: p.top * g.short } : null;
  let fontPx = (band ? band.h * TEXT_IN_BAND : TEXT_CORNER * g.short) * scale;
  const left = band ? inset : g.left + inset;
  const right = band ? g.outW - inset : g.left + g.contentW - inset;
  let width = widthAt(fontPx);
  if (width > right - left) {
    fontPx *= (right - left) / width;
    width = right - left;
  }
  const height = fontPx * 1.2;
  const cy = band ? band.y + band.h / 2 : g.top + g.contentH - inset - height / 2;
  const spot = slide({ from: 1, left, right, cy, width, height, occupied, gap: GAP * g.short });
  return { ...spot, fontPx, region: edge || "photo" };
}

/**
 * A logo layer given another image (its brand's logo was changed): the same
 * visual weight (heights scaled by logoHeightFactor of each shape, as
 * templates size marks) and the same end held, the one nearer its side of
 * the output (a bar's left or right end), else its centre.
 * @param {object} args.layer  the STORED sticker layer
 * @param {object} args.geom   outputGeometry() of the photo being edited
 * @param {number} args.aspect the new image's width / height
 * @returns {{ x: number, scale: number }} stored x and scale
 */
export function swapLogo({ layer, geom, aspect }) {
  const g = geom;
  const oldW = (layer.scale ?? 0.4) * g.fullW;
  const oldAspect = layer.naturalWidth && layer.naturalHeight ? layer.naturalWidth / layer.naturalHeight : 1;
  const height = (oldW / oldAspect) * (logoHeightFactor(aspect) / logoHeightFactor(oldAspect));
  const width = height * aspect;
  const cx = layer.x * g.fullW - g.cropX + g.left;
  let nextCx = cx;
  if (cx < g.outW * 0.4) nextCx = cx - oldW / 2 + width / 2;
  else if (cx > g.outW * 0.6) nextCx = cx + oldW / 2 - width / 2;
  return { x: (nextCx - g.left + g.cropX) / g.fullW, scale: width / g.fullW };
}

/** A canvas background's lightness, 0 (black) to 1 (white): a gradient's is
 *  the mean of its ends. */
export function backgroundLightness(bg) {
  const lightness = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  if (bg?.mode === "gradient" && bg.gradient) {
    const stops = bg.gradient.stops?.length ? bg.gradient.stops.map((s) => s.color) : [bg.gradient.from, bg.gradient.to];
    return stops.reduce((sum, color) => sum + lightness(color), 0) / stops.length;
  }
  return lightness(bg?.color || "#ffffff");
}
