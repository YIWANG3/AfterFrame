// Frame render engine. Pure: given a loaded photo + EXIF + a template (+ a
// pre-built logo-image cache), produce a framed canvas. Reuses the editor's
// existing layer renderer (drawLayers) — template elements are instantiated as
// text/sticker layers, so the frame tool and the text tool share one renderer.
//
// All template sizes/insets are fractions of the photo width (WREF), so output
// is resolution-independent. drawLayers expects fontSize in "1920-ref px" and
// sticker scale as a fraction of the *output* canvas width; we convert.

import { drawLayersOnCanvas } from "./drawLayers";
import { FRAME_FONTS } from "../frameTemplates";
import { brandIdForMake, pickVariant } from "./frameLogos";
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

function resolveTokens(str, exif, profile) {
  if (str == null) return "";
  return String(str).replace(/\{(\w+)\}/g, (_, key) => {
    switch (key) {
      case "camera_model": return exif?.camera_model || "";
      case "lens_model": return exif?.lens_model || "";
      case "date": return captureDate(exif);
      case "author": return profile?.author || "";
      default: return "";
    }
  });
}

// Resolve an anchor to a point on the OUTPUT canvas (fractional x/y) + text
// align. `region` selects which padding band; h/v place within it; inset is a
// margin from the edges; dy nudges vertically. All fractions are of WREF.
function resolveAnchor(anchor, geom) {
  const { outW, outH, padPx, wref } = geom;
  const inset = (anchor.inset ?? 0.05) * wref;
  const dy = (anchor.dy ?? 0) * wref;
  const dx = (anchor.dx ?? 0) * wref;

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

/** Logos a template needs for this photo: [{ brandId, variant, color, colorLocked, key, heightPx }]. */
export function collectLogoNeeds(template, exif, registry, geom) {
  const brandId = brandIdForMake(exif?.make || exif?.camera_model, registry);
  const brand = brandId ? registry.byId.get(brandId) : null;
  const needs = [];
  for (const el of template.elements) {
    if (el.type !== "logo" || !brand) continue;
    const variant = pickVariant(brand, { variantId: el.variant, kind: el.kind, strict: el.strict });
    if (!variant) continue;
    const color = el.color || "#141414";
    const colorLocked = !!variant.colorLocked;
    const key = `${brandId}:${variant.id}:${colorLocked ? "orig" : color}`;
    // Prepare at a generous size so the same cached logo stays crisp in both the
    // small thumbnails and the big preview (cache is keyed by color, not size).
    const heightPx = Math.min(1400, Math.max(320,
      Math.round((el.style?.size || 0.05) * (variant.h ?? 1) * (geom?.outH || 1600) * 2.5)));
    needs.push({ brandId, variant, color, colorLocked, key, heightPx, file: variant.file });
  }
  return needs;
}

function geometry(photo, template) {
  const wref = photo.width || photo.naturalWidth;
  const href = photo.height || photo.naturalHeight;
  const pad = template.canvas?.pad || {};
  const padPx = {
    top: (pad.top || 0) * wref,
    right: (pad.right || 0) * wref,
    bottom: (pad.bottom || 0) * wref,
    left: (pad.left || 0) * wref,
  };
  const outW = Math.round(wref + padPx.left + padPx.right);
  const outH = Math.round(href + padPx.top + padPx.bottom);
  return { wref, href, padPx, outW, outH };
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
export function renderFrame({ photo, exif = {}, profile = {}, template, registry, logoImages = new Map() }) {
  const g = geometry(photo, template);
  const { wref, padPx, outW, outH } = g;
  const factor = wref / outW; // size(frac of wref) -> drawLayers conventions

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Background + photo.
  ctx.fillStyle = template.canvas?.bg?.color || "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(photo, padPx.left, padPx.top, wref, g.href);

  // Optional bottom scrim — keeps on-photo (overlay) text legible regardless of
  // how bright the photo is at the edge.
  const scrim = template.canvas?.scrim;
  if (scrim) {
    const sh = (scrim.height ?? 0.3) * g.href;
    const top = scrim.edge === "top";
    const y0 = top ? padPx.top : padPx.top + g.href - sh;
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + sh);
    // gradient runs dark→transparent away from the edge it hugs
    grad.addColorStop(0, top ? (scrim.to ?? "rgba(0,0,0,0.5)") : (scrim.from ?? "rgba(0,0,0,0)"));
    grad.addColorStop(1, top ? (scrim.from ?? "rgba(0,0,0,0)") : (scrim.to ?? "rgba(0,0,0,0.5)"));
    ctx.fillStyle = grad;
    ctx.fillRect(padPx.left, y0, wref, sh);
  }

  // Resolve which brand applies, for logo lookup.
  const brandId = brandIdForMake(exif?.make || exif?.camera_model, registry);
  const brand = brandId ? registry.byId.get(brandId) : null;

  const layers = [];
  for (const el of template.elements) {
    const a = resolveAnchor(el.anchor, g);

    if (el.type === "logo") {
      if (!brand) continue;
      const variant = pickVariant(brand, { variantId: el.variant, kind: el.kind, strict: el.strict });
      if (!variant) continue;
      const color = el.color || "#141414";
      const key = `${brandId}:${variant.id}:${variant.colorLocked ? "orig" : color}`;
      const img = logoImages.get(key);
      if (!img) continue; // caller didn't prepare it
      // Size logos by HEIGHT (× a per-variant multiplier that normalizes tall
      // square symbols vs short wide wordmarks), so ONE template renders any
      // brand's mark at a consistent visual weight. drawLayers wants the sticker
      // scale as a WIDTH fraction of the output, so convert via the real aspect.
      const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : (variant.aspect || 1);
      const heightFrac = (el.style?.size || 0.05) * (variant.h ?? 1);
      const scale = heightFrac * aspect * factor;
      // Stickers are CENTER-anchored. Shift by half the logo width so its edge
      // (not its center) sits flush at the margin — matching the text's edge.
      let lx = a.x;
      if (a.align === "left") lx = a.x + scale / 2;
      else if (a.align === "right") lx = a.x - scale / 2;
      layers.push({
        type: "sticker", stickerPath: key,
        x: lx, y: a.y, scale,
        rotation: el.style?.rotation ?? 0, opacity: el.style?.opacity ?? 100,
        outlineWidth: 0, outlineColor: "#fff",
      });
      continue;
    }

    // text / exif -> a text layer
    let text;
    if (el.type === "exif") text = formatExif(el.fields, exif, { labeled: el.labeled, sep: el.sep });
    else text = resolveTokens(el.content, exif, profile);
    if (!text) continue; // hide elements with no value

    const family = FRAME_FONTS[el.style?.font] || FRAME_FONTS.grotesk;
    const weight = el.style?.weight ?? 400;
    const italic = !!el.style?.italic;
    const tracking = el.style?.tracking ?? 0;
    const fontPx = (el.style?.size || 0.02) * wref; // rendered px
    const tw = measureTextWidth(text, { fontPx, weight, italic, family, tracking });
    let x = a.x;
    if (a.align === "left") x = a.x - (tw / 2) / outW;
    else if (a.align === "right") x = a.x + (tw / 2) / outW;

    layers.push({
      type: "text", text,
      x, y: a.y, align: a.align,
      fontFamily: family,
      fontSize: (el.style?.size || 0.02) * 1920 * factor,
      fontWeight: weight,
      bold: false,
      italic,
      tracking,
      fillMode: "solid",
      fillColor: el.style?.color || "#141414",
      fillOpacity: 100,
      opacity: el.style?.opacity ?? 100,
      bgMode: "none",
      strokeEnabled: false,
      shadow: false,
      rotation: el.style?.rotation ?? 0,
    });
  }

  drawLayersOnCanvas(ctx, outW, outH, layers, logoImages);
  return canvas;
}
