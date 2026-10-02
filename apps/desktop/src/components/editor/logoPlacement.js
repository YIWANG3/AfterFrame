// Where "My logo" goes when it is clicked (or dropped in): into the frame,
// not the middle of the photo.
//   a bottom band (the usual bar) → its right end, 40% of the band tall and
//                                   centred in it; if something is already
//                                   there (a brand logo, a line of text), its
//                                   centre, then its left end
//   a top band                    → the same, in the top band
//   no band                       → the photo's bottom-right corner, then its
//                                   bottom-left
// Distances are in the content's short edge, like the built-in templates'
// insets (0.05 of 1.5 × the short edge). Everything is in output pixels
// (frameUserTemplates.outputGeometry).

const INSET = 0.075; // of the short edge: the built-in bars' 0.05 × 1.5
const IN_BAND = 0.4; // of the band's height
const MAX_BAND_WIDTH = 0.45; // of the band's width, for a very wide logo
const CORNER = 0.06; // of the short edge, with no band
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

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
  const pick = (candidates, width, height) => {
    const free = candidates.find(({ cx, cy }) => !occupied.some((box) => overlaps(box, {
      x: cx - width / 2, y: cy - height / 2, w: width, h: height,
    })));
    return free || candidates[0];
  };

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
    const cy = band.y + band.h / 2;
    const spot = pick([
      { cx: g.outW - inset - width / 2, cy },
      { cx: g.outW / 2, cy },
      { cx: inset + width / 2, cy },
    ], width, height);
    return { ...spot, width, height, region: edge };
  }

  let height = CORNER * g.short;
  let width = height * aspect;
  if (width > g.contentW * MAX_CORNER_WIDTH) {
    width = g.contentW * MAX_CORNER_WIDTH;
    height = width / aspect;
  }
  const cy = g.top + g.contentH - inset - height / 2;
  const spot = pick([
    { cx: g.left + g.contentW - inset - width / 2, cy },
    { cx: g.left + inset + width / 2, cy },
  ], width, height);
  return { ...spot, width, height, region: "photo" };
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
