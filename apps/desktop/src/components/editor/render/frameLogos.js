// Frame logos — load the brand-logo registry, rasterize an SVG variant to a
// canvas, and tint it (mono SVG -> any color via source-in). A "logo" in a
// frame template is rendered as a pre-tinted image fed through the existing
// sticker layer path in drawLayers — no new layer type needed for v1.
//
// Environment-agnostic: callers provide the raw SVG text (from a Vite glob in
// the dev harness, or from the main process / media:// in the app). This module
// only turns text + color into pixels.

/** Parse the `logos.json` manifest into a lookup-friendly shape. */
export function buildLogoRegistry(manifest) {
  const byId = new Map();
  for (const brand of manifest.logos || []) {
    byId.set(brand.id, brand);
  }
  return { byId, match: manifest.match || {} };
}

/** EXIF `make` (e.g. "HASSELBLAD") -> brand id, via substring match. */
export function brandIdForMake(make, registry) {
  if (!make) return null;
  const m = String(make).toLowerCase();
  for (const [needle, id] of Object.entries(registry.match)) {
    if (m.includes(needle)) return id;
  }
  return null;
}

/** Match both EXIF Make and Model. Some Insta360 files identify the maker as
 *  "Arashi Vision" while carrying the consumer brand only in Model. */
export function brandIdForExif(exif, registry) {
  const haystack = [exif?.make, exif?.camera_model].filter(Boolean).join(" ");
  return brandIdForMake(haystack, registry);
}

function matchesModel(variant, model) {
  if (!variant?.models?.length || !model) return false;
  const normalized = String(model).toLowerCase();
  return variant.models.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

/** Pick a variant from a brand by id, or by kind, or the first available.
 *  With `strict`, return null (instead of falling back) when the requested
 *  variant/kind isn't present — lets dual-logo templates skip a missing mark
 *  rather than duplicate the only one a brand has. */
export function pickVariant(brand, { variantId, kind, strict, model } = {}) {
  if (!brand?.variants?.length) return null;
  const modelVariants = brand.variants.filter((variant) => matchesModel(variant, model));
  if (variantId) {
    // A model-specific wordmark supersedes the generic wordmark. This keeps
    // templates brand-agnostic while allowing product lines such as Luna Ultra
    // to carry their own official lockup.
    const modelVariant = modelVariants.find((x) => x.id === variantId || x.kind === variantId);
    if (modelVariant) return modelVariant;
    const v = brand.variants.find((x) => x.id === variantId);
    if (v) return v;
    if (strict) return null;
  }
  if (kind) {
    const modelVariant = modelVariants.find((x) => x.kind === kind);
    if (modelVariant) return modelVariant;
    const v = brand.variants.find((x) => x.kind === kind);
    if (v) return v;
    if (strict) return null;
  }
  return modelVariants[0] || brand.variants[0];
}

function viewBoxAspect(svgText) {
  const vb = /viewBox\s*=\s*"([^"]+)"/.exec(svgText);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[3] > 0) return p[2] / p[3];
  }
  return 1;
}

// Force explicit pixel width/height on the <svg> so it rasterizes at a known
// size (SVGs authored with width="100%" can decode to a 0-sized image).
function sizeSvg(svgText, wPx, hPx) {
  let s = svgText.replace(/(<svg\b[^>]*?)\swidth\s*=\s*"[^"]*"/i, "$1");
  s = s.replace(/(<svg\b[^>]*?)\sheight\s*=\s*"[^"]*"/i, "$1");
  return s.replace(/<svg\b/i, `<svg width="${wPx}" height="${hPx}"`);
}

function svgToImage(svgText) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}

/** Recolor selected SVG paints while preserving spot colors in a multi-color mark. */
export function recolorSvgColors(svgText, colors, color) {
  if (!color || !colors?.length) return svgText;
  return colors.reduce((text, sourceColor) => {
    const escaped = String(sourceColor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`((?:fill|color)\\s*=\\s*["'])${escaped}(["'])`, "gi"), `$1${color}$2`);
  }, svgText);
}

/**
 * Rasterize + tint a logo variant.
 * @returns {Promise<HTMLCanvasElement>} an RGBA canvas, height ≈ `heightPx`.
 *   When `colorLocked` (or no `color`), original colors are kept.
 */
export async function prepareLogo(svgText, {
  color = "#000", colorLocked = false, tintableColors = [], heightPx = 256,
} = {}) {
  const partiallyTinted = !colorLocked && !!color && tintableColors.length > 0;
  const sourceSvg = partiallyTinted ? recolorSvgColors(svgText, tintableColors, color) : svgText;
  const aspect = viewBoxAspect(sourceSvg);
  const h = Math.max(8, Math.round(heightPx));
  const w = Math.max(8, Math.round(h * aspect));
  const sized = sizeSvg(sourceSvg, w, h);
  const img = await svgToImage(sized);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  if (!colorLocked && color && !partiallyTinted) {
    // Recolor the opaque silhouette to `color`, preserving alpha edges.
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }

  // Return an HTMLImageElement (drawLayers' sticker path checks .complete /
  // .naturalWidth, which a canvas lacks).
  const out = new Image();
  await new Promise((res) => { out.onload = res; out.src = canvas.toDataURL(); });
  return out;
}
