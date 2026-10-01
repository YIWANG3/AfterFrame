// Frame logos — load the brand-logo registry, rasterize an SVG variant to a
// canvas, and tint it (mono SVG -> any color via source-in). A "logo" in a
// frame template is rendered as a pre-tinted image fed through the existing
// sticker layer path in drawLayers — no new layer type needed for v1.
//
// Environment-agnostic: callers provide the raw SVG text (from a Vite glob in
// the dev harness, or from the main process / media:// in the app). This module
// only turns text + color into pixels.

import { modelDisplayName } from "../../../../shared/cameraNameRules.mjs";

export { modelDisplayName };

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
  const m = normalizeMake(make);
  for (const [needle, id] of Object.entries(registry.match || {})) {
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
 *  rather than duplicate the only one a brand has. A brand the user gave one
 *  of their logos has just that one: it fills every slot but a dual
 *  template's symbol, which is left out as for a single-mark brand. */
export function pickVariant(brand, { variantId, kind, strict, model } = {}) {
  const mine = mineFor(brand, model);
  if (mine) return strict && variantId === "symbol" ? null : mine;
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

// ── What a camera is called ──────────────────────────────────────────────
// A model's name, first found wins: the user's name for it (Settings);
// camera-names/manual.json (hand-kept); the rules (shared/cameraNameRules:
// Canon "R6m2" -> "R6 Mark II", Nikon "Z5_2" -> "Z5II", Sony "ILCE-7CM2" ->
// "α7C II"); camera-names/generated.json (built from CC0 sources, for the
// makers still selling cameras); else EXIF as written. A table is looked up
// by the EXIF make, then by the brand (all of a brand's makes: "NIKON
// CORPORATION" and "NIKON"). Models of a brand with the same name are
// one camera (a drone's lenses: FC9113 and FC9184 are both "DJI Air 3S") and
// share a model logo.

/**
 * Names cameras for one registry, the user's names and the name tables.
 * @param {object} registry     built-in brands (buildLogoRegistry)
 * @param {object} cameraNames  { brandKey | modelKey: the user's name }
 * @param {object} [tables]     { manual, generated }: camera-names/*.json
 */
export function cameraNamer(registry, cameraNames = {}, tables = null) {
  const layer = (names) => {
    const byMake = {};
    const byBrand = {};
    for (const [make, models] of Object.entries(names || {})) {
      const brandKey = brandKeyForExif({ make, camera_model: "" }, registry);
      for (const [model, name] of Object.entries(models || {})) {
        (byMake[make] ||= {})[model] = name;
        if (brandKey) (byBrand[brandKey] ||= {})[model] = name;
      }
    }
    // A model's name in this table: by the EXIF make, else by the brand.
    return (brandKey, m, make) => (make != null && byMake[normalizeMake(make)]?.[m]) || byBrand[brandKey]?.[m] || null;
  };
  const manual = layer(tables?.manual?.names);
  const generated = layer(tables?.generated?.names);
  const inTables = new Map(); // brand key -> the models the tables name
  for (const names of [tables?.manual?.names, tables?.generated?.names]) {
    for (const [make, models] of Object.entries(names || {})) {
      const brandKey = brandKeyForExif({ make, camera_model: "" }, registry);
      if (!brandKey) continue;
      if (!inTables.has(brandKey)) inTables.set(brandKey, new Set());
      for (const model of Object.keys(models || {})) inTables.get(brandKey).add(model);
    }
  }
  const brandNames = tables?.manual?.brands || {};

  /** A model's name; `make` (EXIF) is optional for a brand key's model. */
  function modelName(brandKey, model, make) {
    const m = normalizeMake(model);
    const key = modelKeyFor(brandKey, model);
    const ruled = modelDisplayName(brandKey, model);
    return (key && cameraNames[key])
      || manual(brandKey, m, make)
      || (ruled !== String(model || "").trim() ? ruled : null)
      || generated(brandKey, m, make)
      || ruled;
  }
  function brandName(brandKey, make) {
    return cameraNames[brandKey] || registry.byId.get(brandKey)?.name || brandNames[brandKey] || String(make || "").trim();
  }
  /** Every model of a brand the tables or the user name (normalized). */
  function modelsOf(brandKey) {
    const models = new Set(inTables.get(brandKey) || []);
    for (const key of Object.keys(cameraNames)) if (key.startsWith(`${brandKey}#`)) models.add(key.slice(brandKey.length + 1));
    return [...models];
  }
  /** The models that are one camera with this one (itself included). */
  function sameCamera(brandKey, model) {
    const m = normalizeMake(model);
    const name = normalizeMake(modelName(brandKey, m));
    return [m, ...modelsOf(brandKey).filter((other) => other !== m && normalizeMake(modelName(brandKey, other)) === name)];
  }
  return { modelName, brandName, modelsOf, sameCamera, cameraNames };
}

const namerOf = (registry, namesOrNamer) => (typeof namesOrNamer?.modelName === "function" ? namesOrNamer : cameraNamer(registry, namesOrNamer || {}));

/**
 * @param {object} exif      { make, camera_model }
 * @param {object} registry  built-in brands (buildLogoRegistry)
 * @param {object} namer     cameraNamer(), or just the user's { key: name }
 * @returns {{ brandKey, modelKey, brandName, modelName }|null} null with no make
 */
export function cameraNamesFor(exif, registry, namer = {}) {
  const brandKey = brandKeyForExif(exif, registry);
  if (!brandKey) return null;
  const names = namerOf(registry, namer);
  const model = String(exif?.camera_model || "").trim();
  return {
    brandKey,
    modelKey: modelKeyFor(brandKey, model),
    brandName: names.brandName(brandKey, exif?.make),
    modelName: model ? names.modelName(brandKey, model, exif?.make) : "",
  };
}

/** EXIF with the camera's display name for frame text ({camera_model}). */
export function labelExif(exif, registry, namer) {
  const names = cameraNamesFor(exif, registry, namer);
  return names?.modelName ? { ...exif, camera_label: names.modelName } : exif;
}

/** The brand's own general marks (every model shows them). */
export function builtInBrandMarks(brand) {
  return (brand?.variants || []).filter((variant) => !variant.models?.length);
}

/** Built-in marks for this model alone (Insta360's Luna Ultra lockup). */
export function builtInModelMarks(brand, model) {
  return (brand?.variants || []).filter((variant) => matchesModel(variant, model));
}

/** Every built-in mark a camera shows, in the manifest's order: the brand's
 *  general marks, with a model's own mark (Luna Ultra) in place of the
 *  general one of its kind. Sony: α and SONY. */
export function builtInMarks(brand, model) {
  const variants = brand?.variants || [];
  const own = variants.filter((variant) => matchesModel(variant, model));
  return variants.filter((variant) => (variant.models?.length
    ? own.includes(variant)
    : !own.some((mine) => mine.kind === variant.kind)));
}

// ── A camera brand's logo, chosen by the user ─────────────────────────────
// watermarkProfile.brandLogos maps a brand to one of my logos (Settings ›
// Watermark, or the Frame tool): a built-in brand by its id, a camera with no
// built-in logo by "make:<its EXIF make>". One camera model of a brand can
// have its own: "<brand key>#<model>" (DJI's FC9184 apart from other DJI).
// Frames then use that logo wherever they would show the brand's mark, the
// model's choice first; clearing a choice restores what was under it.

export function normalizeMake(make) {
  return String(make || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Where a camera's logo choice is kept: its built-in brand's id, else
 *  "make:<make>"; null when EXIF names no make at all. */
export function brandKeyForExif(exif, registry) {
  const id = brandIdForExif(exif, registry);
  if (id) return id;
  const make = normalizeMake(exif?.make);
  return make ? `make:${make}` : null;
}

/** Where one model's own choice is kept; null without a model. */
export function modelKeyFor(brandKey, model) {
  const m = normalizeMake(model);
  return brandKey && m ? `${brandKey}#${m}` : null;
}

/** My logo standing in for this brand's mark on this model, if any: the
 *  model's own choice, else the brand's. */
export function mineFor(brand, model) {
  const m = normalizeMake(model);
  return (m && brand?.mineModels?.find((v) => v.model === m)) || brand?.mine || null;
}

// Built-in marks are sized by kind: a wide wordmark at 0.45 of a slot's
// height, a square symbol at 0.7 to 1. My logo gets the same by its shape.
export function logoHeightFactor(aspect) {
  return Math.min(0.85, Math.max(0.45, 0.9 / Math.sqrt(aspect || 1)));
}

function myLogoVariant(logo, model) {
  const aspect = logo.width && logo.height ? logo.width / logo.height : 1;
  return {
    id: model ? `mine:${logo.id}:${model}` : `mine:${logo.id}`, kind: "mine", personal: logo.id, name: logo.name, aspect,
    h: logoHeightFactor(aspect), colorLocked: !logo.tintable, ...(model ? { model } : {}),
  };
}

/**
 * The registry with the user's choices folded in: a brand given one of my
 * logos shows only that; a model given one shows it, and the rest of the
 * brand what they did; a camera with no built-in logo becomes a brand of its
 * own, matched by its make. A choice whose logo was deleted changes nothing.
 * @param {object} registry      buildLogoRegistry() output (built-in brands)
 * @param {object} brandLogos    { brandKey | "brandKey#model": personal logo id }
 * @param {Array}  personalLogos my logos (listPersonalLogos)
 * @param {object} [cameraNames] cameraNamer(), or the user's names: models of a
 *   brand with the same name are one camera, and share a model logo set on any
 */
export function withBrandLogos(registry, brandLogos, personalLogos, cameraNames = {}) {
  const entries = Object.entries(brandLogos || {});
  if (!entries.length) return registry;
  const byId = new Map(registry.byId);
  const match = { ...(registry.match || {}) };
  for (const [key, logoId] of entries) {
    const logo = (personalLogos || []).find((l) => l.id === logoId);
    if (!logo) continue;
    const hash = key.indexOf("#");
    const brandKey = hash < 0 ? key : key.slice(0, hash);
    const model = hash < 0 ? null : key.slice(hash + 1);
    let brand = byId.get(brandKey);
    if (!brand) {
      if (!brandKey.startsWith("make:") || brandKey.length <= 5) continue;
      brand = { id: brandKey, name: brandKey.slice(5), variants: [] };
      match[brandKey.slice(5)] = brandKey;
    }
    const mine = myLogoVariant(logo, model);
    byId.set(brandKey, model
      ? { ...brand, mineModels: [...(brand.mineModels || []), mine] }
      : { ...brand, mine });
  }
  // A model logo reaches the models named the same (a drone's other lens).
  const names = namerOf(registry, cameraNames);
  for (const [brandKey, brand] of byId) {
    if (!brand.mineModels?.length) continue;
    const extra = [];
    for (const mine of brand.mineModels) {
      for (const model of names.sameCamera(brandKey, mine.model)) {
        if (model === mine.model || brand.mineModels.some((v) => v.model === model) || extra.some((v) => v.model === model)) continue;
        extra.push({ ...mine, id: `${mine.id}~${model}`, model });
      }
    }
    if (extra.length) byId.set(brandKey, { ...brand, mineModels: [...brand.mineModels, ...extra] });
  }
  return { ...registry, byId, match };
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
