// User frame templates: "save as template" (docs/next-features-plan.md §E).
//
// A built-in template (frameTemplates.js) is a set of anchors resolved for each
// photo. A user template is the LAYERS the user ended up with, plus the canvas
// margins and background. To land on a photo of another shape, each layer is
// pinned to the output edge it sits nearest (left / centre / right, top /
// centre / bottom) at a distance measured in the content's SHORT edge: the unit
// the canvas margins already use, and what built-in templates scale by
// (frameRender.layoutRef). Its size is kept in that unit too, so a bottom bar
// saved on a landscape photo keeps its proportions on a portrait one.
//
// Text that came from a template token ({camera_model}, an EXIF row) keeps its
// `tokenSource` and is resolved again for the photo it lands on; text the user
// retyped has lost it (dropEditedSources) and stays as typed. A brand logo
// keeps its `logoRef` (symbol / wordmark, colour) and is matched to the new
// photo's camera. Its pixels, a data: URL, are never stored.

import { formatExif, resolveTokens } from "./render/frameRender";
import { drawLayersOnCanvas } from "./render/drawLayers";
import { angledLinearGradient } from "./render/canvasHelpers";

export const USER_TEMPLATE_PREFIX = "user:";
export const USER_TEMPLATE_VERSION = 1;
export const isUserTemplate = (tpl) => tpl?.kind === "layers";

// Size fields relative to the layer basis width (imageMath rescaleLayerSize);
// every other field is basis-free and kept as it is.
const TEXT_SIZE_FIELDS = ["fontSize", "shadowBlur", "shadowX", "shadowY", "strokeWidth"];
// Nearer than this (a fraction of the output side) to the middle is "centred".
const CENTERED = 0.02;

/** The composed output of a photo in px: the (cropped) content plus margins,
 *  which are fractions of the content's short edge. */
export function outputGeometry({ fullW, fullH, crop = null, pad = null }) {
  const p = { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) };
  const contentW = crop ? crop.width * fullW : fullW;
  const contentH = crop ? crop.height * fullH : fullH;
  const short = Math.min(contentW, contentH);
  return {
    fullW, fullH, contentW, contentH, short,
    cropX: crop ? crop.x * fullW : 0,
    cropY: crop ? crop.y * fullH : 0,
    left: p.left * short,
    top: p.top * short,
    outW: contentW + (p.left + p.right) * short,
    outH: contentH + (p.top + p.bottom) * short,
  };
}

// A built-in template element → what its layer came from, stamped on the
// layers generatePresetLayers makes so a save can keep it.
export function tokenSourceOf(el) {
  if (el?.type === "exif") return { exif: { fields: [...(el.fields || [])], labeled: !!el.labeled, ...(el.sep ? { sep: el.sep } : {}) } };
  if (el?.type === "text" && /\{\w+\}/.test(String(el.content || ""))) return { content: el.content };
  return null;
}
export function logoRefOf(el) {
  return { variant: el?.variant ?? null, kind: el?.kind ?? null, strict: !!el?.strict, color: el?.color ?? null };
}
// A logoRef as a one-element template, for collectLogoNeeds / prepareLogo.
export function logoElementOf(ref) {
  return { type: "logo", variant: ref.variant ?? undefined, kind: ref.kind ?? undefined, strict: !!ref.strict, color: ref.color ?? undefined, style: { size: 0.05 } };
}

export function resolveSource(source, exif, profile) {
  if (source?.exif) return formatExif(source.exif.fields, exif, { labeled: source.exif.labeled, sep: source.exif.sep });
  return resolveTokens(source?.content, exif, profile);
}

// A text layer the user retyped no longer shows its token: drop the source so
// a saved template keeps the words they chose. `prev` is the stack before the
// edit; layers match by id.
export function dropEditedSources(next, prev) {
  if (!next?.length || !prev?.length) return next;
  const before = new Map(prev.map((layer) => [layer.id, layer]));
  let changed = false;
  const out = next.map((layer) => {
    if (!layer.tokenSource) return layer;
    const old = before.get(layer.id);
    if (!old || old.text === layer.text) return layer;
    changed = true;
    const { tokenSource: _dropped, ...rest } = layer;
    return rest;
  });
  return changed ? out : next;
}

function extent(w, h, rotation) {
  const r = ((rotation || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { ew: c * w + s * h, eh: s * w + c * h };
}

// Which edge a span sits nearest, and how far from it in short edges.
function pinAxis(center, half, length, short, [start, end]) {
  if (Math.abs(center - length / 2) <= CENTERED * length) return { edge: "center", d: (center - length / 2) / short };
  const fromStart = center - half;
  const fromEnd = length - (center + half);
  return fromStart <= fromEnd ? { edge: start, d: fromStart / short } : { edge: end, d: fromEnd / short };
}
function placeAxis(pin, half, length, short) {
  if (!pin || pin.edge === "center") return length / 2 + (pin?.d || 0) * short;
  if (pin.edge === "left" || pin.edge === "top") return pin.d * short + half;
  return length - pin.d * short - half;
}

function textBox(layer, fontPx, measure) {
  const text = String(layer.text ?? "");
  const lines = Math.max(1, text.split("\n").length);
  const w = measure(text, {
    fontPx, weight: layer.fontWeight ?? (layer.bold ? 700 : 400), italic: !!layer.italic,
    family: layer.fontFamily, tracking: layer.tracking || 0,
  });
  return { w, h: fontPx * (layer.lineHeight || 1.2) * lines };
}

/**
 * The editor's current look → a user template.
 * @param {object} args
 * @param {Array}  args.layers   STORED layers (full-photo basis)
 * @param {object} args.geom     outputGeometry() of the photo being edited, with its crop and pad
 * @param {object} args.pad      canvas margins (short-edge fractions)
 * @param {object} args.bg       canvas background
 * @param {(text: string, font: object) => number} args.measure  rendered text width in px
 * @returns {{ template: object, skipped: number }} skipped: stickers that exist only as
 *   pixels in a data: URL (a handwriting sticker) and cannot travel in a template
 */
export function templateFromLayers({ id, name, layers, geom, pad, bg, measure }) {
  const g = geom;
  const saved = [];
  let skipped = 0;
  for (const layer of layers || []) {
    const { id: _id, x, y, fromPreset: _preset, ...rest } = layer;
    if (layer.type === "overlay") {
      saved.push(rest);
      continue;
    }
    const cx = x * g.fullW - g.cropX + g.left;
    const cy = y * g.fullH - g.cropY + g.top;
    if (layer.type === "sticker") {
      if (!layer.logoRef && String(layer.stickerPath || "").startsWith("data:")) {
        skipped += 1;
        continue;
      }
      const { scale, stickerPath, naturalWidth, naturalHeight, ...style } = rest;
      const widthPx = (scale ?? 0.4) * g.fullW;
      const aspect = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 1;
      const heightPx = widthPx / aspect;
      const { ew, eh } = extent(widthPx, heightPx, layer.rotation);
      saved.push({
        ...style,
        // A logo is found again for each photo; a library sticker is a file.
        ...(layer.logoRef ? {} : { stickerPath, naturalWidth, naturalHeight }),
        heightS: heightPx / g.short,
        pin: { h: pinAxis(cx, ew / 2, g.outW, g.short, ["left", "right"]), v: pinAxis(cy, eh / 2, g.outH, g.short, ["top", "bottom"]) },
      });
      continue;
    }
    const style = { ...rest };
    const sizeS = {};
    for (const field of TEXT_SIZE_FIELDS) {
      sizeS[field] = (((layer[field] ?? 0) * g.fullW) / 1920) / g.short;
      delete style[field];
    }
    const { w, h } = textBox(layer, sizeS.fontSize * g.short, measure);
    const { ew, eh } = extent(w, h, layer.rotation);
    saved.push({
      ...style,
      sizeS,
      pin: { h: pinAxis(cx, ew / 2, g.outW, g.short, ["left", "right"]), v: pinAxis(cy, eh / 2, g.outH, g.short, ["top", "bottom"]) },
    });
  }
  return {
    template: {
      id, name, kind: "layers", version: USER_TEMPLATE_VERSION,
      canvas: { pad: { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) }, bg: bg ? JSON.parse(JSON.stringify(bg)) : null },
      layers: saved,
    },
    skipped,
  };
}

/**
 * A user template on a photo → layers in the OUTPUT basis (positions as output
 * fractions, sizes relative to the output width): what generatePresetLayers
 * builds before it stores them.
 * @param {object} tpl  a user template
 * @param {object} args
 * @param {object} args.geom     outputGeometry() of the photo with the template's pad
 * @param {object} args.exif     the photo's EXIF (useFrameTool exifFromItem)
 * @param {object} args.profile  { author }
 * @param {Function} args.measure  as in templateFromLayers
 * @param {(ref: object, heightPx: number) => ({ src, naturalWidth, naturalHeight } | null)} args.logoFor
 *   the brand logo for this photo, or null when its camera has none: the layer is left out
 */
export function layersFromTemplate(tpl, { geom, exif, profile, measure, logoFor }) {
  const g = geom;
  const layers = [];
  for (const saved of tpl?.layers || []) {
    if (saved.type === "overlay") {
      layers.push({ ...saved });
      continue;
    }
    const { pin, heightS, sizeS, ...style } = saved;
    if (saved.type === "sticker") {
      const heightPx = (heightS || 0) * g.short;
      const image = saved.logoRef ? logoFor?.(saved.logoRef, heightPx) : null;
      if (saved.logoRef && !image) continue;
      const naturalWidth = image?.naturalWidth ?? saved.naturalWidth;
      const naturalHeight = image?.naturalHeight ?? saved.naturalHeight;
      const widthPx = heightPx * (naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 1);
      const { ew, eh } = extent(widthPx, heightPx, saved.rotation);
      layers.push({
        ...style,
        ...(image ? { stickerPath: image.src, naturalWidth, naturalHeight } : {}),
        x: placeAxis(pin?.h, ew / 2, g.outW, g.short) / g.outW,
        y: placeAxis(pin?.v, eh / 2, g.outH, g.short) / g.outH,
        scale: widthPx / g.outW,
      });
      continue;
    }
    const text = saved.tokenSource ? resolveSource(saved.tokenSource, exif, profile) : saved.text;
    if (!text) continue; // a token this photo has no value for: hidden, as built-ins do
    const layer = { ...style, text };
    for (const field of TEXT_SIZE_FIELDS) layer[field] = ((sizeS?.[field] ?? 0) * g.short * 1920) / g.outW;
    const { w, h } = textBox(layer, (sizeS?.fontSize ?? 0) * g.short, measure);
    const { ew, eh } = extent(w, h, saved.rotation);
    layer.x = placeAxis(pin?.h, ew / 2, g.outW, g.short) / g.outW;
    layer.y = placeAxis(pin?.v, eh / 2, g.outH, g.short) / g.outH;
    layers.push(layer);
  }
  return layers;
}

/**
 * Compose a photo with a user template: background, photo, then its layers.
 * Used for the panel thumbnails and by the agent's apply_frame. Library
 * stickers must already be in `stickerImages` (keyed by path); logos are added
 * as logoFor returns them.
 */
export function renderUserTemplate({ photo, template, exif, profile, measure, logoFor, stickerImages = new Map() }) {
  const fullW = photo.naturalWidth || photo.width;
  const fullH = photo.naturalHeight || photo.height;
  const g = outputGeometry({ fullW, fullH, pad: template.canvas?.pad });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(g.outW);
  canvas.height = Math.round(g.outH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const bg = template.canvas?.bg;
  ctx.fillStyle = bg?.mode === "gradient" && bg.gradient
    ? angledLinearGradient(ctx, bg.gradient, canvas.width, canvas.height, { fromDefault: "#ffffff", toDefault: "#000000" })
    : bg?.color || "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(photo, g.left, g.top, g.contentW, g.contentH);
  const images = new Map(stickerImages);
  const layers = layersFromTemplate(template, {
    geom: g, exif, profile, measure,
    logoFor: (ref, heightPx) => {
      const image = logoFor?.(ref, heightPx);
      if (image?.src) images.set(image.src, image);
      return image;
    },
  }).map((layer) => (layer.type === "overlay"
    ? { ...layer, overlayRect: { x: g.left / g.outW, y: g.top / g.outH, width: g.contentW / g.outW, height: g.contentH / g.outH } }
    : layer));
  drawLayersOnCanvas(ctx, canvas.width, canvas.height, layers, images);
  return canvas;
}
