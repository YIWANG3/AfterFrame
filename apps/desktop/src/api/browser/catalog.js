// The catalog itself: info and summary, the sample library, browsing and
// locating, facet options, and the writes to one photo (rating, flag,
// description, delete).

import { familyOf, formatLabel } from "../../../shared/formats.mjs";
import sampleManifest from "../../../sample-photos/manifest.json";
import { assets, collections, newAssetId, showDescription } from "./state";
import { aggregateTags, facetUniverse, matchesFacetFilters, matchesRules, matchesSearch, sortAssets } from "./query";

const samplePhotos = import.meta.glob("../../../sample-photos/*.jpg", { query: "?url", import: "default", eager: true });
const sampleThumbs = import.meta.glob("../../../sample-photos/previews/*.jpg", { query: "?url", import: "default", eager: true });
let sampleLoad = null;

async function browseImages({ status = "all", limit = 180, offset = 0, search, sort, filters, base } = {}) {
  let list = assets;
  // A smart collection's rules are the base set and carry their own status.
  if (base) list = list.filter((a) => matchesRules(a, base));
  else if (status === "rated") list = list.filter((a) => a.app_rating > 0);
  else if (status === "matched") list = [];
  if (search) list = list.filter((a) => matchesSearch(a, search));
  if (filters) list = list.filter((a) => matchesFacetFilters(a, filters));
  return sortAssets(list, sort).slice(offset, offset + limit);
}

async function browseCollection(collectionId, { limit = 180, offset = 0, search, filters, sort } = {}) {
  const row = collections.find((c) => c.collection_id === collectionId);
  if (!row) return [];
  const byId = new Map(assets.map((a) => [a.asset_id, a]));
  let list = (row.asset_ids || []).map((id) => byId.get(id)).filter(Boolean);
  if (search) list = list.filter((a) => matchesSearch(a, search));
  if (filters) list = list.filter((a) => matchesFacetFilters(a, filters));
  // asset_ids is in the order photos were added; the sidecar's default is
  // most recently added first.
  if (!sort || sort === "added-desc") list = [...list].reverse();
  else if (sort !== "added-asc") list = sortAssets(list, sort);
  return list.slice(offset, offset + limit);
}

// The renderer passes the selection, a list (an id alone still works).
const idSet = (assetIds) => new Set(Array.isArray(assetIds) ? assetIds : [assetIds]);

export const catalogMethods = {
  // ── workspace / catalog ──
  getInfo: async () => ({
    rootDir: "/",
    catalogPath: assets.length ? "/web.afcatalog" : null,
    scratchCatalogPath: null,
    sidecarSrc: null,
    isSampleCatalog: false,
  }),
  openSampleCatalog: () => {
    if (sampleLoad) return sampleLoad;
    sampleLoad = (async () => {
      for (const [path, url] of Object.entries(samplePhotos).sort()) {
        const name = path.split("/").pop();
        if (assets.some(asset => asset.source === "sample" && asset.file_name === name)) continue;
        const original = new URL(url, document.baseURI).href + `#/${name}`;
        const thumb = new URL(sampleThumbs[path.replace("/sample-photos/", "/sample-photos/previews/")], document.baseURI).href + `#/${name}`;
        assets.push({
          asset_id: newAssetId(), source: "sample", asset_type: "image",
          file_name: name, stem: name.replace(/\.[^.]+$/, ""),
          exists_on_disk: true, app_rating: 0, annotation: null, tags: [], aiTags: [], description: null, description_source: null, userDescription: null, has_face: false,
          imported_at: new Date().toISOString(), image_metadata: sampleManifest[name],
          image_path: original, preview_path: thumb, image_preview_path: thumb,
          image_preview_hd_path: original, preview_hd_path: original, _objectUrls: [],
        });
      }
      return { path: "/web.afcatalog" };
    })().finally(() => { sampleLoad = null; });
    return sampleLoad;
  },
  switchCatalog: async () => {},
  getSummary: async () => ({
    image_assets: assets.length,
    browse_assets: assets.length,
    raw_assets: 0,
    rated_count: assets.filter((a) => a.app_rating > 0).length,
    confirmed_matches: 0,
    recently_added_count: assets.length,
    updated_at: null,
  }),
  getCatalogRoots: async () => [],
  registerRoots: async () => {},
  getWatchedDirs: async () => [],
  detectEditors: async () => [],

  // ── facets: aggregate over the in-memory catalog, mirroring the sidecar's
  // get_facet_values keys (db/browse.py) ──
  getFacetValues: async (view = {}) => {
    const metasFor = (facet) => facetUniverse(facet, view).map((a) => a.image_metadata || {});
    const counts = (values) => {
      const m = new Map();
      for (const v of values) { if (v) m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([value, count]) => ({ value, count }));
    };
    const minMax = (facet, key) => {
      const vals = metasFor(facet).map((m) => m[key]).filter((v) => v != null && Number.isFinite(Number(v)));
      return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : { min: null, max: null };
    };
    const times = metasFor("capture_time").map((m) => m.capture_time).filter(Boolean).sort();
    const sourceOf = (m) => (m.gps_latitude != null && m.gps_longitude != null ? "exif" : "none");
    return {
      location_sources: ["exif", "none"]
        .map((value) => ({ value, count: metasFor("location_source").filter((m) => sourceOf(m) === value).length }))
        .filter((row) => row.count > 0),
      cameras: counts(metasFor("camera").map((m) => m.camera_model)),
      lenses: counts(metasFor("lens").map((m) => m.lens_model)),
      tags: aggregateTags(60, "", facetUniverse("tag", view)),
      extensions: counts(facetUniverse("extension", view).map((a) => familyOf(a.file_name)))
        .map((row) => ({ ...row, label: formatLabel(row.value) })),
      iso: minMax("iso", "iso"),
      aperture: minMax("aperture", "aperture"),
      focal: minMax("focal", "focal_length"),
      shutter: minMax("shutter", "shutter_speed"),
      capture_time: times.length ? { min: times[0], max: times[times.length - 1] } : { min: null, max: null },
    };
  },
  listCameraMakes: async () => {
    const makes = new Map();
    for (const asset of facetUniverse("camera", {})) {
      const meta = asset.image_metadata || {};
      const make = String(meta.camera_make || "").trim();
      if (!make) continue;
      const entry = makes.get(make) || { make, count: 0, models: new Map() };
      entry.count += 1;
      if (meta.camera_model) entry.models.set(meta.camera_model, (entry.models.get(meta.camera_model) || 0) + 1);
      makes.set(make, entry);
    }
    return [...makes.values()]
      .sort((a, b) => b.count - a.count || a.make.localeCompare(b.make))
      .map(({ make, count, models }) => ({ make, count, models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m) }));
  },
  searchFacet: async ({ field, q = "", limit = 50, ...view } = {}) => {
    const needle = String(q).toLowerCase();
    const universe = facetUniverse(field, view);
    const pick = (get) => {
      const m = new Map();
      for (const a of universe) {
        const v = get(a);
        if (v && String(v).toLowerCase().includes(needle)) m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([value, count]) => ({ value, count }));
    };
    if (field === "camera") return pick((a) => a.image_metadata?.camera_model);
    if (field === "lens") return pick((a) => a.image_metadata?.lens_model);
    if (field === "extension") return pick((a) => familyOf(a.file_name));
    if (field === "tag") return aggregateTags(limit, needle, universe);
    return [];
  },

  // ── browse ──
  locateImageAsset: async ({ assetId, collectionId, ...scope } = {}) => {
    const rows = collectionId
      ? await browseCollection(collectionId, { limit: Number.MAX_SAFE_INTEGER })
      : await browseImages({ ...scope, limit: Number.MAX_SAFE_INTEGER });
    const index = rows.findIndex((row) => row.asset_id === assetId);
    return { index: index < 0 ? null : index };
  },
  browseImages,
  // The web catalog has no gazetteer; the Discover page falls back to
  // month groups when both lists are empty.
  discoverCollections: async () => ({ places: [], memories: [] }),
  // Location points for the map drawer, scoped like the gallery. Same row
  // shape as the sidecar's browse-map-points; all web points are EXIF-exact.
  browseMapPoints: async ({ status = "all", collectionId, search, filters, base } = {}) => {
    let list = assets;
    if (base && !collectionId) list = list.filter((a) => matchesRules(a, base));
    if (collectionId) {
      const row = collections.find((c) => c.collection_id === collectionId);
      const member = new Set(row?.asset_ids || []);
      list = list.filter((a) => member.has(a.asset_id));
    } else if (!base && status === "rated") list = list.filter((a) => a.app_rating > 0);
    else if (!base && status === "matched") list = [];
    // A folder is narrowed by search and facets like any other scope.
    if (search) list = list.filter((a) => matchesSearch(a, search));
    if (filters) {
      const nonGeo = { ...filters };
      delete nonGeo.geo;
      list = list.filter((a) => matchesFacetFilters(a, nonGeo));
    }
    return list
      .filter((a) => a.image_metadata?.gps_latitude != null && a.image_metadata?.gps_longitude != null)
      .map((a) => ({
        asset_id: a.asset_id,
        latitude: a.image_metadata.gps_latitude,
        longitude: a.image_metadata.gps_longitude,
        source: "exif",
        accuracy_m: null,
        precision_level: "exact",
        place_id: null,
        app_rating: a.app_rating,
        capture_time: a.image_metadata.capture_time || null,
        preview_path: a.preview_path,
      }));
  },
  browseCollection,
  getAssetDetailById: async (assetId) => {
    return assets.find((a) => a.asset_id === assetId) || null;
  },
  ensureHdPreviews: async () => {},

  // ── writes to one photo ──
  setAssetRating: async (assetIds, rating) => {
    const ids = idSet(assetIds);
    for (const a of assets) if (ids.has(a.asset_id)) a.app_rating = rating;
    return { ok: true };
  },
  setAssetDescription: async (assetIds, text) => {
    const ids = idSet(assetIds);
    let updated = 0;
    for (const a of assets) {
      if (!ids.has(a.asset_id)) continue;
      a.userDescription = text === null ? null : String(text || "").trim();
      showDescription(a);
      updated += 1;
    }
    return { ok: true, description: text === null ? null : String(text || "").trim() || null, reset: text === null, updated };
  },
  setAssetFlag: async (assetIds, flag) => {
    const value = { pick: 1, reject: -1, none: 0 }[flag];
    if (value === undefined) throw new Error(`unknown flag: ${flag}`);
    const ids = idSet(assetIds);
    let updated = 0;
    for (const a of assets) if (ids.has(a.asset_id)) { a.app_flag = value; updated += 1; }
    return { ok: true, flag, updated };
  },
  deleteImageAssets: async (assetIds) => {
    const ids = idSet(assetIds);
    for (let i = assets.length - 1; i >= 0; i--) {
      if (ids.has(assets[i].asset_id)) {
        for (const u of assets[i]._objectUrls || []) URL.revokeObjectURL(u);
        assets.splice(i, 1);
      }
    }
    // Keep collections consistent with the deleted assets.
    for (const row of collections) {
      row.asset_ids = row.asset_ids.filter((id) => !ids.has(id));
    }
    return { removed: ids.size };
  },
  copyText: (text) => navigator.clipboard?.writeText?.(String(text ?? "")),
};
