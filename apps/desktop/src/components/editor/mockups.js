// The camera mockups in frame-mockups/: which cameras there are, which one a
// photo gets, and their pictures. Deleting the folder takes the feature away
// cleanly: there are then no mockups and the frame tool doesn't offer one.
//
// The pictures load as data URLs (a chunk each, fetched the first time a
// camera is used): a picture from the packaged app's file:// pages would taint
// the canvas the export is read back from.

const manifests = import.meta.glob("/frame-mockups/mockups.json", { eager: true, import: "default" });
const pictures = import.meta.glob("/frame-mockups/images/*.webp", { query: "?inline", import: "default" });

const manifest = manifests["/frame-mockups/mockups.json"] || null;

/** Every camera with a picture: { id, brand, name, match, brandDefault?, file,
 *  size, screen, source }. */
export const MOCKUPS = (manifest?.mockups || []).filter((m) => pictures[`/frame-mockups/${m.file}`]);
/** The cameras a photo from an unknown camera gets, landscape and portrait. */
export const GENERIC_MOCKUPS = manifest?.generic || {};
export const mockupsAvailable = MOCKUPS.length > 0;

const byId = new Map(MOCKUPS.map((m) => [m.id, m]));
export function mockupById(id) {
  return byId.get(id) || null;
}

// ── Which camera ────────────────────────────────────────────────────────────

// Maker names EXIF puts in front of a model, dropped before comparing.
const MAKER_PREFIXES = [
  "leica camera ag", "ricoh imaging company, ltd.", "om digital solutions", "nikon corporation",
  "om system", "hasselblad", "fujifilm", "panasonic", "olympus", "nikon", "canon", "sony",
  "leica", "ricoh", "pentax", "sigma", "lumix", "fuji",
];

/** A model name to compare by: lower case, the maker dropped, letters and
 *  digits only ("NIKON Z 6_2" → "z62", "Sony α7 IV" → "a7iv"). */
export function modelKey(name) {
  let s = String(name || "").toLowerCase().replace(/α/g, "a").trim();
  for (let again = true; again;) {
    again = false;
    for (const p of MAKER_PREFIXES) {
      if (s === p || s.startsWith(`${p} `)) { s = s.slice(p.length).trim(); again = true; }
    }
  }
  return s.replace(/[^a-z0-9]/g, "");
}

const BRAND_WORDS = [
  ["hasselblad", "hasselblad"], ["leica", "leica"], ["canon", "canon"], ["nikon", "nikon"],
  ["sony", "sony"], ["panasonic", "panasonic"], ["lumix", "panasonic"], ["fujifilm", "fujifilm"],
  ["fuji", "fujifilm"], ["ricoh", "ricoh"], ["om digital", "om"], ["om system", "om"],
  ["olympus", "om"], ["sigma", "sigma"],
];

/** The maker of the camera that took a photo, as mockups.json names makers. */
export function mockupBrandOf(exif) {
  const s = `${exif?.make || ""} ${exif?.camera_model || ""}`.toLowerCase();
  // A Pentax says RICOH IMAGING in Make: its model decides.
  if (s.includes("pentax")) return "pentax";
  return BRAND_WORDS.find(([word]) => s.includes(word))?.[1] || null;
}

const keysCache = new WeakMap();
function keysOf(m) {
  if (!keysCache.has(m)) keysCache.set(m, new Set([...(m.match || []), m.name].map(modelKey).filter(Boolean)));
  return keysCache.get(m);
}

function ownMockup(exif, list) {
  const brand = mockupBrandOf(exif);
  const keys = [exif?.camera_model, exif?.camera_label].map(modelKey).filter(Boolean);
  return keys.length ? list.find((m) => (!brand || m.brand === brand) && keys.some((k) => keysOf(m).has(k))) || null : null;
}

function makersMockup(exif, list) {
  const brand = mockupBrandOf(exif);
  return brand ? list.find((m) => m.brand === brand && m.brandDefault) || list.find((m) => m.brand === brand) || null : null;
}

/** How a photo's camera is matched: "model" (its own), "brand" (its maker's
 *  usual one), or "none" (a phone, a maker with no camera here, no EXIF). */
export function mockupMatchFor(exif, list = MOCKUPS) {
  if (ownMockup(exif, list)) return "model";
  return makersMockup(exif, list) ? "brand" : "none";
}

/** Is the camera `id` of the photo's own maker? */
export function mockupOfMaker(id, exif) {
  const brand = mockupBrandOf(exif);
  return !!brand && byId.get(id)?.brand === brand;
}

/** The camera for a photo: its own model, else its maker's usual camera,
 *  else the generic one for its orientation. */
export function pickMockupId(exif, { portrait = false, list = MOCKUPS, generic = GENERIC_MOCKUPS } = {}) {
  const found = ownMockup(exif, list) || makersMockup(exif, list);
  if (found) return found.id;
  const g = portrait ? generic.portrait : generic.landscape;
  return list.some((m) => m.id === g) ? g : list[0]?.id ?? null;
}

/** canvas.mockup (or a template's) with the camera settled: "auto" or a camera
 *  no longer there becomes the photo's own. Null when there are no mockups. */
export function resolveMockupSpec(spec, exif, contentW, contentH) {
  if (!spec) return null;
  const id = spec.id && spec.id !== "auto" && byId.has(spec.id)
    ? spec.id
    : pickMockupId(exif, { portrait: contentH > contentW * 1.02 });
  if (!id) return null;
  return {
    id,
    fit: spec.fit === "fill" ? "fill" : "contain",
    rotation: spec.rotation === 0 || spec.rotation === -90 || spec.rotation === 90 ? spec.rotation : "auto",
    layout: spec.layout === "stack" ? "stack" : "screen",
    reflection: !!spec.reflection,
    exposure: Math.max(-100, Math.min(100, Math.round(Number(spec.exposure) || 0))),
    radius: Math.max(0, Math.min(100, Math.round(Number(spec.radius) || 0))),
  };
}

// ── Pictures ────────────────────────────────────────────────────────────────

const loading = new Map();
const loaded = new Map();

/** The camera's picture, once loaded (null when it can't be). */
export function loadMockupImage(id) {
  const m = byId.get(id);
  if (!m) return Promise.resolve(null);
  if (!loading.has(id)) {
    loading.set(id, pictures[`/frame-mockups/${m.file}`]()
      .then((src) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { loaded.set(id, img); resolve(img); };
        img.onerror = () => resolve(null);
        img.src = src;
      }))
      .catch(() => null)
      .then((img) => { if (!img) loading.delete(id); return img; }));
  }
  return loading.get(id);
}

/** The camera's picture if it has loaded already, else null. */
export function mockupImageIfLoaded(id) {
  return loaded.get(id) || null;
}
