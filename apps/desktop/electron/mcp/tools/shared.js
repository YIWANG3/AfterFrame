// What several tool files share: the compact asset record search results
// return, the facet-condition schema and parser search_assets and smart
// collection rules have in common, and the thumbnail URL.

function thumbnailUrl(port, assetId) {
  return `http://127.0.0.1:${port}/assets/${assetId}`;
}

function compactAsset(row, port) {
  const meta = row.image_metadata || {};
  return {
    asset_id: row.asset_id,
    asset_type: row.asset_type || "image",
    stem: row.stem,
    image_path: row.image_path,
    rating: row.app_rating || 0,
    flag: row.app_flag === 1 ? "pick" : row.app_flag === -1 ? "reject" : undefined,
    capture_time: meta.capture_time || null,
    camera: meta.camera_model || null,
    lens: meta.lens_model || null,
    iso: meta.iso ?? null,
    aperture: meta.aperture ?? null,
    focal_length: meta.focal_length ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    // How it shows (width/height are the pixels as stored, which a camera's
    // upright shot keeps landscape). Absent until its thumbnail was read.
    shape: row.display_shape || undefined,
    duration: row.asset_type === "video" ? meta.duration ?? null : undefined,
    match_status: row.match_status,
    // The description as shown: the user's if written, else the AI's caption.
    caption: row.description ?? row.annotation?.caption ?? null,
    caption_source: row.description_source || undefined,
    // Hand-added and AI tags alike (asset_tags).
    tags: row.tags?.length ? row.tags : row.annotation?.tags?.length ? row.annotation.tags : undefined,
    has_raw: !!row.raw_asset_id,
    has_face: row.has_face ? true : undefined,
    // Only surfaced when something is wrong — keeps the common case compact.
    missing_original: row.exists_on_disk === false ? true : undefined,
    source_changed: row.source_changed === true ? true : undefined,
    resource_set_id: row.resource_set_id || null,
    version_kind: row.version_kind || null,
    thumbnail_url: row.preview_path ? thumbnailUrl(port, row.asset_id) : null,
  };
}

// {lat, lng, km} → the bounds-mode bbox the sidecar's geo filter understands.
function nearToBounds(near) {
  const lat = Number(near.lat);
  const lng = Number(near.lng);
  const km = Number(near.km) || 5;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("near requires numeric lat and lng.");
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    mode: "bounds",
    west: Math.max(-180, lng - dLng),
    east: Math.min(180, lng + dLng),
    south: Math.max(-90, lat - dLat),
    north: Math.min(90, lat + dLat),
  };
}

// Several values within one facet are OR ("FC9113 or FC9184": either drone);
// different facets are AND. A single string still works.
const ONE_OR_MANY = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };

// The facet conditions shared by search_assets and smart collection rules,
// under the names agents already know from search_assets. (geo is search-only:
// a map area is not something a smart collection saves.)
const FACET_ARG_KEYS = [
  "camera", "lens", "iso_min", "iso_max", "aperture_min", "aperture_max",
  "focal_min", "focal_max", "date_from", "date_to", "date_within_days", "rating_min", "rating_max", "flag", "orientation", "tag", "tag_match",
  "asset_type", "extension", "shutter_min", "shutter_max", "people", "annotated",
  "location_source", "country", "city", "color", "color_tolerance", "caption_contains", "ocr_contains", "path_contains",
];
// The conditions an agent may flip with `exclude`, by the names it sends them
// under → the sidecar's facet names (db/facets.py).
const EXCLUDABLE_ARGS = {
  camera: "camera", lens: "lens", tag: "tag", extension: "extension", orientation: "orientation", flag: "flag",
  asset_type: "asset_type", location_source: "location_source", country: "country", city: "city",
  color: "color", person_id: "person_group", collection_id: "in_collection",
  caption_contains: "caption_contains", ocr_contains: "ocr_contains", path_contains: "path_contains",
};
const oneOrMany = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]);

function facetFiltersFrom(source, { groups = true } = {}) {
  const filters = {};
  for (const key of FACET_ARG_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") filters[key] = source[key];
  }
  if (source.person_id) filters.person_group = String(source.person_id);
  // "The five-star photos of this folder": membership of a folder as a condition.
  if (source.collection_id) filters.in_collection = String(source.collection_id);
  const excluded = oneOrMany(source.exclude).map((name) => {
    if (!EXCLUDABLE_ARGS[name]) throw new Error(`exclude: '${name}' is not a condition that can be excluded (one of ${Object.keys(EXCLUDABLE_ARGS).join(", ")}).`);
    return EXCLUDABLE_ARGS[name];
  });
  if (excluded.length) filters.exclude = excluded;
  if (source.any_of !== undefined && source.any_of !== null) {
    if (!groups) throw new Error("any_of groups do not nest.");
    if (!Array.isArray(source.any_of)) throw new Error("any_of must be a list of condition groups.");
    filters.any_of = source.any_of.map((group) => facetFiltersFrom(group || {}, { groups: false }));
  }
  return filters;
}

// manage_collections `rules` → what the sidecar stores for a smart collection.
function smartRulesFrom(rules) {
  if (!rules || typeof rules !== "object") throw new Error("rules is required for a smart collection.");
  return { status: rules.status || "all", search: rules.query ? String(rules.query) : "", filters: facetFiltersFrom(rules) };
}

// The schema of the conditions above that search_assets and smart collection
// rules share. any_of groups take the same names (without any_of).
const EXCLUDE_ARG = {
  type: "array",
  items: { type: "string", enum: Object.keys(EXCLUDABLE_ARGS) },
  description: "Conditions to turn into their opposite: exclude ['camera'] with camera 'X' means NOT shot on X; " +
    "['tag'] means none of the tags; ['collection_id'] means not in that folder. A photo without the value counts as not matching it.",
};
const ANY_OF_ARG = {
  type: "array",
  items: { type: "object" },
  description: "Groups of conditions, at least one of which must hold (OR), on top of the other conditions (AND). " +
    "Each group is an object with the same condition names (camera, tag, rating_min, collection_id, exclude, ...) AND-combined; groups do not nest. " +
    "E.g. (5 stars from Canon) or anything tagged 'night': any_of [{camera: 'Canon EOS R5', rating_min: 5}, {tag: 'night'}].",
};

module.exports = { thumbnailUrl, compactAsset, nearToBounds, facetFiltersFrom, smartRulesFrom, ONE_OR_MANY, EXCLUDE_ARG, ANY_OF_ARG };
