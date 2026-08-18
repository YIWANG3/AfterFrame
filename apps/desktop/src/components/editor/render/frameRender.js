// Frame render engine. Pure: given a loaded photo + EXIF + a template (+ a
// pre-built logo-image cache), produce a framed canvas. Reuses the editor's
// existing layer renderer (drawLayers) — template elements are instantiated as
// text/sticker layers, so the frame tool and the text tool share one renderer.
//
// All template sizes/insets are fractions of one LAYOUT REFERENCE length
// (WREF, see layoutRef()), so output is resolution-independent. drawLayers
// expects fontSize in "1920-ref px" and sticker scale as a fraction of the
// *output* canvas width; we convert.

import { drawLayersOnCanvas } from "./drawLayers";
import { drawScrim } from "./canvasHelpers";
import { FRAME_FONTS } from "../frameTemplates";
import { brandIdForExif, pickVariant } from "./frameLogos";
import {
  formatAperture, formatShutterSpeed, formatFocalLength, formatISO,
} from "../../../utils/format";

const EXIF_FORMATTERS = {
  focal: (e) => formatFocalLength(e.focal_length),
  aperture: (e) => formatAperture(e.aperture),
  shutter: (e) => formatShutterSpeed(e.shutter_speed),
  iso: (e) => formatISO(e.iso),
};

// Labeled mode (Phocus "Aperture | f/13"): a word label + bare value. ISO drops
// its baked-in "ISO " prefix since the label already says it.
const EXIF_LABELS = { focal: "Focal", aperture: "Aperture", shutter: "Shutter", iso: "ISO" };
const EXIF_VALUES = {
  focal: (e) => formatFocalLength(e.focal_length),
  aperture: (e) => formatAperture(e.aperture),
  shutter: (e) => formatShutterSpeed(e.shutter_speed),
  iso: (e) => (Number(e?.iso) ? String(Math.round(Number(e.iso))) : null),
};

function formatExif(fields, exif, { labeled = false, sep } = {}) {
  const parts = (fields || [])
    .map((f) => {
      if (labeled) {
        const v = EXIF_VALUES[f] ? EXIF_VALUES[f](exif) : null;
        return v ? `${EXIF_LABELS[f] || ""} | ${v}` : null;
      }
      return EXIF_FORMATTERS[f] ? EXIF_FORMATTERS[f](exif) : null;
    })
    .filter(Boolean);
  // Hasselblad's separator is the pipe, never a middot. Labeled groups sit apart
  // with wide space (the pipe lives inside each "Label | value"); a value-only
  // line falls back to a spaced pipe. Override per-template via `sep`.
  return parts.join(sep || (labeled ? "       " : "   |   "));
}

// drawLayers anchors a text layer's *box center* at x (align only shifts the
// glyph by ±tw/2 within that box). To make left/right-anchored frame text sit
// flush at the margin, we measure the rendered width and offset x accordingly.
let _measureCtx = null;
function measureTextWidth(text, { fontPx, weight, italic, family, tracking }) {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = `${italic ? "italic " : ""}${weight} ${fontPx}px "${family}", sans-serif`;
  if ("letterSpacing" in _measureCtx) _measureCtx.letterSpacing = `${(tracking || 0) * fontPx}px`;
  return _measureCtx.measureText(text || " ").width;
}

function captureDate(exif) {
  const t = exif?.capture_time;
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function resolveTokens(str, exif, profile, coveredFields = new Set()) {
  if (str == null) return "";
  return String(str).replace(/\{(\w+)\}/g, (_, key) => {
    if (coveredFields.has(key)) return "";
    switch (key) {
      case "camera_model": return exif?.camera_model || "";
      case "lens_model": return exif?.lens_model || "";
      case "date": return captureDate(exif);
      case "author": return profile?.author || "";
      default: return "";
    }
  }).trim();
}

export function coveredFieldsFromLogoVariants(variants) {
  return new Set((variants || []).flatMap((variant) => variant?.covers || []));
}

// Resolve an anchor to a point on the OUTPUT canvas (fractional x/y) + text
// align. `region` selects which padding band; h/v place within it; inset is a
// margin from the edges; dy nudges vertically. All fractions are of WREF.
function resolveAnchor(anchor, geom, adjust) {
  const { outW, outH, padPx, wref } = geom;
  const m = adjust?.margin ?? 1; // offsets scale with the band so layout stays proportional
  const inset = (anchor.inset ?? 0.05) * wref * m;
  const dy = (anchor.dy ?? 0) * wref * m;
  const dx = (anchor.dx ?? 0) * wref * m;

  // Side strips — a left/right padding band; content (usually rotated text) is
  // centered across the narrow strip and placed by v over the FULL height.
  if (anchor.region === "left" || anchor.region === "right") {
    const bandLeft = anchor.region === "left" ? 0 : outW - padPx.right;
    const bandW = anchor.region === "left" ? padPx.left : padPx.right;
    const hFrac = anchor.h === "left" ? 0.3 : anchor.h === "right" ? 0.7 : 0.5;
    const vF = typeof anchor.v === "number" ? anchor.v
      : anchor.v === "top" ? 0.12 : anchor.v === "bottom" ? 0.88 : 0.5;
    return { x: (bandLeft + bandW * hFrac + dx) / outW, y: (outH * vF + dy) / outH, align: "center" };
  }

  let bandTop, bandH;
  if (anchor.region === "top") { bandTop = 0; bandH = padPx.top; }
  else if (anchor.region === "bottom") { bandTop = outH - padPx.bottom; bandH = padPx.bottom; }
  else { bandTop = 0; bandH = outH; } // "full"

  const vFrac = typeof anchor.v === "number" ? anchor.v
    : anchor.v === "top" ? 0.32 : anchor.v === "bottom" ? 0.68 : 0.5;
  const yPx = bandTop + bandH * vFrac + dy;

  let xPx, align;
  if (anchor.h === "left") { xPx = inset; align = "left"; }
  else if (anchor.h === "right") { xPx = outW - inset; align = "right"; }
  else { xPx = outW / 2; align = "center"; }
  xPx += dx;

  return { x: xPx / outW, y: yPx / outH, align };
}

// A logo's color is normally template-driven (dark on light frames, white on
// dark). But brands with an ICONIC color (Canon red, Sony α orange) carry a
// `color` in the manifest and should keep it — except when a template forces a
// specific non-neutral color (e.g. the gold preset). colorLocked brands (Leica)
// keep their SVG colors regardless.
const NEUTRAL_LOGO_COLORS = new Set([undefined, "#141414", "#f4f4f4", "#ffffff"]);
function logoColorFor(el, variant, override) {
  // User override (黑/白/灰/金) wins — except color-locked marks (Leica) that
  // can't be cleanly re-tinted; those keep their original.
  if (override && !variant?.colorLocked) return override;
  const base = el.color || "#141414";
  // Per-VARIANT iconic color: Canon's wordmark is red, Sony's α symbol is orange,
  // but Sony's corporate SONY wordmark stays mono — so the color lives on the
  // variant, not the brand.
  if (!variant?.colorLocked && variant?.color && NEUTRAL_LOGO_COLORS.has(el.color)) return variant.color;
  return base;
}

/** Return the rotated visual bounds of a logo and optionally keep them inside
 *  the canvas vertically. `scale` and width are output-width fractions; height
 *  is converted to an output-height fraction. */
export function fitLogoBounds({
  x, y, scale, aspect, rotation, outW, outH, clampY = false, edgeInsetY = 0,
}) {
  const normalizedRotation = ((rotation % 180) + 180) % 180;
  const quarterTurn = Math.abs(normalizedRotation - 90) < 0.001;
  const boundsFor = (nextScale) => ({
    w: quarterTurn ? nextScale / aspect : nextScale,
    h: quarterTurn
      ? nextScale * (outW / outH)
      : (nextScale / aspect) * (outW / outH),
  });

  let fittedScale = scale;
  let bounds = boundsFor(fittedScale);
  let fittedY = y;
  if (clampY) {
    const availableH = Math.max(0.01, 1 - edgeInsetY * 2);
    if (bounds.h > availableH) {
      fittedScale *= availableH / bounds.h;
      bounds = boundsFor(fittedScale);
    }
    const minY = edgeInsetY + bounds.h / 2;
    const maxY = 1 - edgeInsetY - bounds.h / 2;
    fittedY = minY <= maxY ? Math.min(maxY, Math.max(minY, fittedY)) : 0.5;
  }

  return { x, y: fittedY, scale: fittedScale, ...bounds };
}

/** Logos a template needs for this photo: [{ brandId, variant, color, colorLocked, key, heightPx }]. */
export function collectLogoNeeds(template, exif, registry, geom, logoColor) {
  const brandId = brandIdForExif(exif, registry);
  const brand = brandId ? registry.byId.get(brandId) : null;
  const needs = [];
  for (const el of template.elements) {
    if (el.type !== "logo" || !brand) continue;
    const variant = pickVariant(brand, {
      variantId: el.variant, kind: el.kind, strict: el.strict, model: exif?.camera_model,
    });
    if (!variant) continue;
    const color = logoColorFor(el, variant, logoColor);
    const colorLocked = !!variant.colorLocked;
    const key = `${brandId}:${variant.id}:${colorLocked ? "orig" : color}`;
    // Prepare at a generous size so the same cached logo stays crisp in both the
    // small thumbnails and the big preview (cache is keyed by color, not size).
    const heightPx = Math.min(1400, Math.max(320,
      Math.round((el.style?.size || 0.05) * (variant.h ?? 1) * (geom?.outH || 1600) * 2.5)));
    needs.push({
      brandId, variant, color, colorLocked, tintableColors: variant.tintableColors,
      key, heightPx, file: variant.file,
    });
  }
  return needs;
}

// Template fractions (pad bands, insets, text size, logo height) are all
// relative to ONE reference length so the frame chrome scales as a unit. That
// reference is the photo's SHORT edge × 1.5 — i.e. exactly the width of a 3:2
// landscape frame (the aspect the templates were tuned on), so 3:2 renders as
// before while portrait, square and panoramic photos get the same visual weight
// of logo/text/margins relative to the picture. Sizing by raw width made a
// 16:9/pano logo ~2× the height-relative size of the same logo on a 4:5.
export const LAYOUT_REF_PER_SHORT_EDGE = 1.5;
export function layoutRef(width, height) {
  return Math.min(width, height) * LAYOUT_REF_PER_SHORT_EDGE;
}

export function geometry(photo, template, adjust) {
  const photoW = photo.width || photo.naturalWidth;
  const href = photo.height || photo.naturalHeight;
  const wref = layoutRef(photoW, href);
  const pad = template.canvas?.pad || {};
  const m = adjust?.margin ?? 1; // "blank area" knob scales the padding bands
  const padPx = {
    top: (pad.top || 0) * wref * m,
    right: (pad.right || 0) * wref * m,
    bottom: (pad.bottom || 0) * wref * m,
    left: (pad.left || 0) * wref * m,
  };
  const outW = Math.round(photoW + padPx.left + padPx.right);
  const outH = Math.round(href + padPx.top + padPx.bottom);
  return { wref, photoW, href, padPx, outW, outH };
}

// Average luminance (0..1) of a canvas region — for picking legible text color
// on a photo. Sampled AFTER the photo + scrim are drawn, so the scrim counts.
function sampleLuminance(ctx, cx, cy, w, h) {
  const x = Math.max(0, Math.round(cx - w / 2));
  const y = Math.max(0, Math.round(cy - h / 2));
  const ww = Math.max(1, Math.min(ctx.canvas.width - x, Math.round(w)));
  const hh = Math.max(1, Math.min(ctx.canvas.height - y, Math.round(h)));
  let data;
  try { data = ctx.getImageData(x, y, ww, hh).data; } catch { return 0.3; }
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 16) { // every 4th pixel
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  return n ? sum / n / 255 : 0.3;
}

// Turn a template's declarative elements into concrete drawable layers
// (text + sticker/logo) at anchor-resolved positions. Extracted from
// renderFrame so the same "template → layers" conversion can feed both the
// baked export and (later) the editable layer stack. Takes `ctx` because
// overlay (on-photo) text picks its color from the luminance already drawn.
export function buildFrameLayers(ctx, { template, exif, profile, geom, adjust, factor, registry, logoImages, logoColor, isOverlay }) {
  const g = geom;
  const adj = adjust;
  const { wref, outW, outH } = geom;
  // Resolve which brand applies, for logo lookup.
  const brandId = brandIdForExif(exif, registry);
  const brand = brandId ? registry.byId.get(brandId) : null;

  // Resolve logo slots once. A product lockup can declare that it already
  // contains an EXIF field (e.g. Luna Ultra includes the camera model). Only
  // suppress that text when the matching logo image is actually available.
  const resolvedLogoElements = new Map();
  if (brand) {
    template.elements.forEach((el, index) => {
      if (el.type !== "logo") return;
      const variant = pickVariant(brand, {
        variantId: el.variant, kind: el.kind, strict: el.strict, model: exif?.camera_model,
      });
      if (!variant) return;
      const color = logoColorFor(el, variant, logoColor);
      const key = `${brandId}:${variant.id}:${variant.colorLocked ? "orig" : color}`;
      const img = logoImages.get(key);
      if (img) resolvedLogoElements.set(index, { variant, color, key, img });
    });
  }
  const coveredFields = coveredFieldsFromLogoVariants(
    [...resolvedLogoElements.values()].map(({ variant }) => variant),
  );

  // Dual-logo templates degrade gracefully on single-mark brands: if only one
  // of the two logo slots resolves, center it via each element's `soloAnchor`.
  const resolvedLogos = resolvedLogoElements.size;
  const solo = template.family === "dual" && resolvedLogos === 1;

  // Vertical auto-centering for text stacks: elements sharing a `group` are
  // centered as a unit around their shared anchor. So when a line is empty —
  // e.g. a fixed-lens camera (Ricoh GR, Fuji X100) has no lens_model — the
  // remaining line(s) stay centered instead of hanging off to one side. The
  // computed offset is ADDED to the group's shared base `dy`.
  const groupDy = new Map();
  const groupStyle = new Map();
  const groupMembers = new Map();
  const stacks = new Map();
  template.elements.forEach((el, i) => {
    if (!el.group || el.type === "logo") return;
    if (!groupMembers.has(el.group)) groupMembers.set(el.group, []);
    groupMembers.get(el.group).push(i);
    const t = el.type === "exif"
      ? formatExif(el.fields, exif, { labeled: el.labeled, sep: el.sep })
      : resolveTokens(el.content, exif, profile, coveredFields);
    if (!t) return; // empty line — excluded from the stack
    if (!stacks.has(el.group)) stacks.set(el.group, []);
    stacks.get(el.group).push(i);
  });
  for (const [group, idxs] of stacks) {
    const members = groupMembers.get(group) || [];
    // If the primary line is absent (for Luna Ultra it is already present in
    // the product lockup), promote the remaining lens line into the primary
    // line's visual role instead of leaving a tiny gray orphan.
    if (idxs.length === 1 && members[0] !== idxs[0]) {
      groupStyle.set(idxs[0], {
        ...(template.elements[idxs[0]].style || {}),
        ...(template.elements[members[0]]?.style || {}),
      });
    }
    const lh = idxs.map((i) => ((groupStyle.get(i) || template.elements[i].style)?.size || 0.02) * adj.text * 1.6);
    const total = lh.reduce((s, h) => s + h, 0);
    let cur = -total / 2;
    idxs.forEach((i, k) => { groupDy.set(i, cur + lh[k] / 2); cur += lh[k]; });
  }

  const layers = [];
  for (let ei = 0; ei < template.elements.length; ei++) {
    const el = template.elements[ei];
    let anchorDef = solo && el.soloAnchor ? { ...el.anchor, ...el.soloAnchor } : el.anchor;
    if (groupDy.has(ei)) anchorDef = { ...anchorDef, dy: (anchorDef.dy || 0) + groupDy.get(ei) };
    const a = resolveAnchor(anchorDef, g, adj);

    if (el.type === "logo") {
      const resolved = resolvedLogoElements.get(ei);
      if (!resolved) continue;
      const { variant, key, img } = resolved;
      // Size logos by HEIGHT (× a per-variant multiplier that normalizes tall
      // square symbols vs short wide wordmarks), so ONE template renders any
      // brand's mark at a consistent visual weight. drawLayers wants the sticker
      // scale as a WIDTH fraction of the output, so convert via the real aspect.
      const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : (variant.aspect || 1);
      const heightFrac = (el.style?.size || 0.05) * (variant.h ?? 1) * adj.text;
      const scale = heightFrac * aspect * factor;
      // In a narrow side strip a wide wordmark won't fit horizontally — rotate it
      // to read vertically. Square-ish marks (symbols/roundels) stay upright.
      const inStrip = anchorDef.region === "left" || anchorDef.region === "right";
      const rotation = (inStrip && aspect > 1.6) ? 90 : (el.style?.rotation ?? 0);
      // A wide wordmark becomes tall after the automatic 90° rotation. Clamp
      // that ROTATED box inside the canvas; otherwise a top anchor such as 0.1
      // can place its first letters above the frame and crop them off.
      const bounds = fitLogoBounds({
        x: a.x,
        y: a.y,
        scale,
        aspect,
        rotation,
        outW,
        outH,
        clampY: inStrip,
        edgeInsetY: inStrip ? Math.max(2 / outH, 0.015 * wref / outH) : 0,
      });
      // Stickers are CENTER-anchored. Shift by half the ROTATED visual width so
      // its edge (not its center) sits flush at the margin.
      let lx = a.x;
      if (a.align === "left") lx = a.x + bounds.w / 2;
      else if (a.align === "right") lx = a.x - bounds.w / 2;
      layers.push({
        type: "sticker", stickerPath: key, ei,
        x: lx, y: bounds.y, scale: bounds.scale,
        // Bounding box for editor hit-testing: size (output fractions) + the
        // element's ROTATED visual center (cx/cy). Stickers are center-anchored,
        // so cx/cy are also the draw position.
        box: { w: bounds.w, h: bounds.h, cx: lx, cy: bounds.y },
        rotation, opacity: el.style?.opacity ?? 100,
        outlineWidth: 0, outlineColor: "#fff",
        // On a photo, give the mark a soft shadow so a light logo survives a
        // bright background (we can't re-tint the cached image per-region).
        shadow: isOverlay, shadowColor: "#000000", shadowOpacity: 45,
        shadowBlur: 10, shadowX: 0, shadowY: 0,
      });
      continue;
    }

    // text / exif -> a text layer
    let text;
    if (el.type === "exif") text = formatExif(el.fields, exif, { labeled: el.labeled, sep: el.sep });
    else text = resolveTokens(el.content, exif, profile, coveredFields);
    if (!text) continue; // hide elements with no value

    const style = groupStyle.get(ei) || el.style || {};
    const family = FRAME_FONTS[style.font] || FRAME_FONTS.grotesk;
    const weight = style.weight ?? 400;
    const italic = !!style.italic;
    const tracking = style.tracking ?? 0;
    const sizeFrac = (style.size || 0.02) * adj.text;
    const fontPx = sizeFrac * wref; // rendered px
    const tw = measureTextWidth(text, { fontPx, weight, italic, family, tracking });
    let x = a.x;
    if (a.align === "left") x = a.x - (tw / 2) / outW;
    else if (a.align === "right") x = a.x + (tw / 2) / outW;

    // On-photo text: choose black/white by the luminance behind it (scrim
    // included) and add an opposite-color soft shadow, so it's legible on any
    // photo — solving "dark text vanishes on a dark photo" and vice versa.
    let fillColor = style.color || "#141414";
    let shadow = false, shadowColor = "#000000";
    if (isOverlay && ctx) {
      // On-photo text: pick black/white by the luminance behind it (needs the
      // photo already drawn — i.e. a real ctx).
      const lum = sampleLuminance(ctx, a.x * outW, a.y * outH, outW * 0.34, fontPx * 1.6);
      const dark = lum < 0.55;
      fillColor = dark ? "#ffffff" : "#141414";
      shadowColor = dark ? "#000000" : "#ffffff";
      shadow = true;
    } else if (isOverlay) {
      // No ctx (generating layers for the editor / hit-testing, before any
      // render): can't sample — assume a light mark on the photo.
      fillColor = "#ffffff";
      shadowColor = "#000000";
      shadow = true;
    }

    layers.push({
      type: "text", text, ei,
      x, y: a.y, align: a.align,
      // Bounding box for editor hit-testing: size (output fractions) + the text's
      // VISUAL center (cx/cy). drawLayers positions by align, so the center sits
      // ±half-width off the anchor a.x depending on alignment.
      box: {
        w: tw / outW, h: (fontPx * 1.2) / outH,
        cx: a.x + (a.align === "left" ? (tw / 2) / outW : a.align === "right" ? -(tw / 2) / outW : 0),
        cy: a.y,
      },
      fontFamily: family,
      fontSize: sizeFrac * 1920 * factor,
      fontWeight: weight,
      bold: false,
      italic,
      tracking,
      fillMode: "solid",
      fillColor,
      fillOpacity: 100,
      opacity: style.opacity ?? 100,
      bgMode: "none",
      strokeEnabled: false,
      shadow,
      shadowColor,
      shadowOpacity: 38,
      shadowBlur: sizeFrac * 1920 * factor * 0.4,
      shadowX: 0,
      shadowY: 0,
      rotation: style.rotation ?? 0,
    });
  }
  return layers;
}

/**
 * Render the framed photo.
 * @param {object} args
 * @param {HTMLImageElement|HTMLCanvasElement} args.photo
 * @param {object} args.exif
 * @param {object} [args.profile]  { author, ... }
 * @param {object} args.template
 * @param {object} args.registry   buildLogoRegistry() output
 * @param {Map<string, HTMLImageElement>} [args.logoImages] key -> tinted image
 * @returns {HTMLCanvasElement}
 */
export function renderFrame({ photo, exif = {}, profile = {}, template, registry, logoImages = new Map(), adjust, logoColor }) {
  const adj = { text: adjust?.text ?? 1, margin: adjust?.margin ?? 1 };
  const g = geometry(photo, template, adj);
  const { wref, photoW, padPx, outW, outH } = g;
  const factor = wref / outW; // size(frac of wref) -> drawLayers conventions
  const isOverlay = template.family === "overlay"; // on-photo text needs adaptive contrast

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  // Only overlay templates read pixels back (sampleLuminance for adaptive text
  // contrast); flag those so getImageData is fast + silent. Non-overlay stays
  // GPU-backed for fast drawing.
  const ctx = canvas.getContext("2d", isOverlay ? { willReadFrequently: true } : undefined);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Background + photo.
  ctx.fillStyle = template.canvas?.bg?.color || "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(photo, padPx.left, padPx.top, photoW, g.href);

  // Optional edge scrim — keeps on-photo (overlay) text legible regardless of
  // how bright the photo is at the edge.
  drawScrim(ctx, template.canvas?.scrim, { x: padPx.left, y: padPx.top, width: photoW, height: g.href });

  const layers = buildFrameLayers(ctx, {
    template, exif, profile, geom: g, adjust: adj, factor,
    registry, logoImages, logoColor, isOverlay,
  });

  drawLayersOnCanvas(ctx, outW, outH, layers, logoImages);

  return canvas;
}
