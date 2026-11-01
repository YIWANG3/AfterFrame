// Browse semantics over the in-memory catalog: the sidecar's sort orders,
// search clause, facet filters and smart-collection rules (db/browse.py,
// db/facets.py), as predicates over asset records.

import { filterExtensions } from "../../../shared/formats.mjs";
import { assets, collections, fileExt, normalizeTag } from "./state";

// The toolbar's sort orders. `assets` is in import order, oldest first.
export function sortAssets(list, sort) {
  const sorted = [...list];
  if (sort === "name-asc") sorted.sort((a, b) => a.stem.localeCompare(b.stem));
  else if (sort === "name-desc") sorted.sort((a, b) => b.stem.localeCompare(a.stem));
  else if (sort === "rating-desc") sorted.sort((a, b) => b.app_rating - a.app_rating);
  else if (sort === "captured-asc" || sort === "captured-desc") {
    // ISO strings compare lexicographically; missing capture_time sinks last.
    const key = (a) => a.image_metadata?.capture_time || "￿";
    sorted.sort((a, b) => key(a).localeCompare(key(b)));
    if (sort === "captured-desc") sorted.reverse();
  } else if (!sort || sort.endsWith("-desc")) sorted.reverse(); // imported desc
  return sorted;
}

// A smart collection's rules as a predicate (sidecar _base_clause): its status,
// search and filters, AND its nested base. The gallery's search and filters
// then refine inside whatever this lets through.
export function matchesRules(asset, rules, depth = 0) {
  if (!rules || depth >= 4) return true;
  if (rules.status === "rated" && !(asset.app_rating > 0)) return false;
  if (rules.status === "matched") return false;
  if (rules.search && !matchesSearch(asset, rules.search)) return false;
  if (!matchesFacetFilters(asset, rules.filters || {})) return false;
  return matchesRules(asset, rules.base, depth + 1);
}

// Sidecar _search_clause fields, minus paths: stem, camera/lens, annotation
// caption/detected_text/tags.
export function matchesSearch(asset, search) {
  const q = String(search).toLowerCase();
  const meta = asset.image_metadata || {};
  const ann = asset.annotation;
  return [asset.stem, meta.camera_model, meta.lens_model, asset.userDescription, ann?.caption, ann?.detected_text]
    .some((v) => v && String(v).toLowerCase().includes(q))
    || (asset.tags || []).some((t) => String(t).toLowerCase().includes(q));
}

// Mirrors the sidecar's facet filter semantics (db/browse.py _facet_clauses),
// AND-combined. Faces/annotations/person groups don't exist on the web
// catalog, so "with" matches nothing and "without" matches everything.
// A facet value is a scalar or a list; several values within one facet are OR
// (sidecar db/facets.py).
export const facetValues = (raw) => (raw == null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw]).filter((v) => v != null && v !== "");

// The filter keys each facet owns (sidecar db/facets.py FACETS): a facet named
// in `exclude` is tested on its own and then flipped, and counting a facet's
// options leaves its own keys out.
export const FACET_OWN_KEYS = {
  camera: ["camera"], lens: ["lens"], iso: ["iso_min", "iso_max"], aperture: ["aperture_min", "aperture_max"],
  focal: ["focal_min", "focal_max"], shutter: ["shutter_min", "shutter_max"],
  capture_time: ["date_from", "date_to", "date_within_days"], rating: ["rating_min", "rating_max"], flag: ["flag"],
  orientation: ["orientation"], asset_type: ["asset_type"], tag: ["tag", "tag_match"], extension: ["extension"],
  people: ["people"], annotated: ["annotated"], person_group: ["person_group"], location_source: ["location_source"],
  country: ["country"], city: ["city"], color: ["color", "color_tolerance"], caption_contains: ["caption_contains"],
  ocr_contains: ["ocr_contains"], path_contains: ["path_contains"], geo: ["geo"], in_collection: ["in_collection"],
};
const FILTER_MODIFIERS = new Set(["tag_match", "color_tolerance", "exclude"]);
const holdsCondition = (filters) => Object.entries(filters).some(([key, value]) => key !== "any_of" && !FILTER_MODIFIERS.has(key) && facetValues(value).length > 0);

// `exclude` flips the facets it names (a photo without the value is not a
// match, so it passes); `any_of` groups need one of them to hold, on top of
// the rest. Empty groups are ignored, as the sidecar does.
export function matchesFacetFilters(asset, filters) {
  const { exclude, any_of: groups, ...rest } = filters;
  for (const name of facetValues(exclude)) {
    const own = Object.fromEntries((FACET_OWN_KEYS[name] || []).filter((key) => key in rest).map((key) => [key, rest[key]]));
    for (const key of Object.keys(own)) delete rest[key];
    if (holdsCondition(own) && matchesFacetConditions(asset, own)) return false;
  }
  const alternatives = (Array.isArray(groups) ? groups : []).filter((group) => group && holdsCondition(group));
  if (alternatives.length && !alternatives.some((group) => matchesFacetFilters(asset, group))) return false;
  return matchesFacetConditions(asset, rest);
}

function matchesFacetConditions(asset, filters) {
  const meta = asset.image_metadata || {};
  const cameras = facetValues(filters.camera);
  if (cameras.length && !cameras.includes(meta.camera_model)) return false;
  const lenses = facetValues(filters.lens);
  if (lenses.length && !lenses.includes(meta.lens_model)) return false;
  for (const [key, field] of [["iso", "iso"], ["aperture", "aperture"], ["focal", "focal_length"], ["shutter", "shutter_speed"]]) {
    const lo = filters[`${key}_min`];
    const hi = filters[`${key}_max`];
    if (lo != null && !(meta[field] != null && meta[field] >= lo)) return false;
    if (hi != null && !(meta[field] != null && meta[field] <= hi)) return false;
  }
  const day = meta.capture_time ? String(meta.capture_time).slice(0, 10) : null;
  if (filters.date_from && !(day && day >= String(filters.date_from).slice(0, 10))) return false;
  if (filters.date_to && !(day && day <= String(filters.date_to).slice(0, 10))) return false;
  if (Number(filters.date_within_days) > 0) {
    const since = new Date(Date.now() - Number(filters.date_within_days) * 86_400_000).toISOString().slice(0, 10);
    if (!(day && day >= since)) return false;
  }
  if (filters.rating_min != null && !(asset.app_rating >= filters.rating_min)) return false;
  // Unrated is 0 stars: rating_max 0 means "not rated yet".
  if (filters.rating_max != null && !((asset.app_rating || 0) <= filters.rating_max)) return false;
  const flags = facetValues(filters.flag);
  if (flags.length) {
    const flag = asset.app_flag === 1 ? "pick" : asset.app_flag === -1 ? "reject" : "none";
    if (!flags.includes(flag)) return false;
  }
  const orientations = facetValues(filters.orientation);
  if (orientations.length) {
    const shape = meta.height > meta.width ? "portrait" : meta.width > meta.height ? "landscape" : meta.width ? "square" : null;
    if (!orientations.includes(shape)) return false;
  }
  // A family ("jpeg") stands for all its extensions; "jpg" for that one.
  const extensions = facetValues(filters.extension).flatMap(filterExtensions);
  if (extensions.length && !extensions.includes(fileExt(asset.file_name))) return false;
  const wanted = facetValues(filters.tag).map(normalizeTag);
  if (wanted.length) {
    const has = new Set((asset.tags || []).map(normalizeTag));
    const hit = filters.tag_match === "all" ? wanted.every((t) => has.has(t)) : wanted.some((t) => has.has(t));
    if (!hit) return false;
  }
  if (filters.people === "with_faces") return false;
  if (filters.annotated === "with" && !asset.annotation) return false;
  if (filters.annotated === "without" && asset.annotation) return false;
  if (filters.person_group) return false;
  // Web locations only ever come from EXIF.
  const sources = facetValues(filters.location_source);
  if (sources.length) {
    const source = meta.gps_latitude != null && meta.gps_longitude != null ? "exif" : "none";
    if (!sources.includes(source)) return false;
  }
  if (facetValues(filters.color).length) return false; // no colours in the browser
  // No gazetteer in the browser, so no photo has a country or a city: the
  // chips never show (no options), and a rule naming one matches nothing.
  if (facetValues(filters.country).length || facetValues(filters.city).length) return false;
  const contains = (text, needle) => String(text || "").toLowerCase().includes(String(needle).trim().toLowerCase());
  // The description as shown: the user's, else the AI's caption.
  if (String(filters.caption_contains || "").trim() && !contains(asset.description, filters.caption_contains)) return false;
  if (String(filters.ocr_contains || "").trim() && !contains(asset.annotation?.detected_text, filters.ocr_contains)) return false;
  if (String(filters.path_contains || "").trim() && !contains(asset.image_path || asset.file_name, filters.path_contains)) return false;
  const folders = facetValues(filters.in_collection);
  if (folders.length && !folders.some((id) => (collections.find((c) => c.collection_id === id)?.asset_ids || []).includes(asset.asset_id))) return false;
  if (filters.geo && !matchesGeo(meta, filters.geo)) return false;
  return true;
}

// Map viewport filter (sidecar _geo_filter_clause semantics). Web locations
// only come from EXIF, so exclude-exif or place mode can never match.
function matchesGeo(meta, geo) {
  if (!geo || typeof geo !== "object") return true;
  if (geo.mode === "place") return false;
  if (geo.mode !== "bounds") return true;
  if (geo.include_exif === false) return false;
  const lat = meta.gps_latitude;
  const lon = meta.gps_longitude;
  if (lat == null || lon == null) return false;
  const west = Number(geo.west); const east = Number(geo.east);
  const south = Number(geo.south); const north = Number(geo.north);
  if (![west, east, south, north].every(Number.isFinite)) return true;
  if (!(lat >= south && lat <= north)) return false;
  // Antimeridian-crossing viewport: split the longitude test.
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

// The photos one facet's options are counted over (sidecar _facet_scope): the
// folder or status, the search text and every OTHER active filter. A facet's
// own keys (FACET_OWN_KEYS) are dropped so its dropdown can still be used to
// switch value.
export function facetUniverse(facet, { collectionId, status = "all", search, filters, base } = {}) {
  let list = assets;
  if (base && !collectionId) list = list.filter((a) => matchesRules(a, base));
  if (collectionId) {
    const member = new Set(collections.find((c) => c.collection_id === collectionId)?.asset_ids || []);
    list = list.filter((a) => member.has(a.asset_id));
  } else if (!base && status === "rated") list = list.filter((a) => a.app_rating > 0);
  else if (!base && status === "matched") list = [];
  if (search) list = list.filter((a) => matchesSearch(a, search));
  const others = { ...(filters || {}) };
  for (const key of FACET_OWN_KEYS[facet] || []) delete others[key];
  return Object.keys(others).length ? list.filter((a) => matchesFacetFilters(a, others)) : list;
}

export function aggregateTags(limit = 50, needle = "", universe = assets) {
  const q = needle.toLowerCase();
  const m = new Map();
  for (const a of universe) {
    for (const t of a.tags || []) {
      if (!q || t.toLowerCase().includes(q)) m.set(t, (m.get(t) || 0) + 1);
    }
  }
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
