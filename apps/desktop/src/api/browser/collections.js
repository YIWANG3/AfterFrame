// Folders and smart collections (manual albums, sidecar row shape).

import { assets, collections, emitCatalogChanged, folderAssetIds, subtreeIds } from "./state";
import { matchesRules } from "./query";

// Live, not a membership list.
const smartCount = (rules) => assets.filter((a) => matchesRules(a, rules)).length;
const EMPTY_STATS = { last_added_at: null, captured_from: null, captured_to: null, cover_preview_paths: [] };
// What the sidecar's list-collections carries for the folder page
// (db/collections.py collection_stats): asset_ids is in the order photos
// joined, so the newest four are its tail; the row's updated_at moves with
// every add, which stands in for the sidecar's per-item added_at.
function folderStats(row, assetIds) {
  if (!assetIds?.length) return EMPTY_STATS;
  const byId = new Map(assets.map((a) => [a.asset_id, a]));
  const times = assetIds.map((id) => byId.get(id)?.image_metadata?.capture_time).filter(Boolean).sort();
  return {
    last_added_at: row.updated_at,
    captured_from: times[0] || null,
    captured_to: times[times.length - 1] || null,
    cover_preview_paths: [...assetIds].reverse().slice(0, 4)
      .map((id) => byId.get(id)?.preview_path || byId.get(id)?.image_path).filter(Boolean),
  };
}
// Where a folder sits (sidecar list-collections: path, depth, subtree_count).
function treeFields(row) {
  if (row.kind !== "manual") return { path: row.name, depth: 0, subtree_count: 0 };
  const names = [row.name];
  const seen = new Set([row.collection_id]);
  let parent = row.parent_collection_id;
  while (parent && !seen.has(parent)) {
    const up = collections.find((c) => c.collection_id === parent && c.kind === "manual");
    if (!up) break;
    seen.add(parent);
    names.push(up.name);
    parent = up.parent_collection_id;
  }
  return { path: names.reverse().join(" / "), depth: names.length - 1, subtree_count: folderAssetIds(row.collection_id, true).length };
}
const folderRow = (id) => collections.find((c) => c.collection_id === id && c.kind === "manual") || null;
// New and moved folders go on top of their level, like the sidecar's.
const topOfLevel = (parentId) => Math.min(1, ...collections.filter((c) => c.kind === "manual" && (c.parent_collection_id || null) === (parentId || null)).map((c) => c.sort_order || 0)) - 1;
const publicCollection = ({ asset_ids, ...row }) => (row.kind === "smart"
  ? { ...row, ...EMPTY_STATS, ...treeFields(row), item_count: row.rules ? smartCount(row.rules) : 0 }
  : { ...row, ...folderStats(row, asset_ids), ...treeFields(row), item_count: asset_ids?.length ?? 0 });
let nextCollectionId = 1;

const emitCollectionsChanged = () => emitCatalogChanged("collections");

export const collectionMethods = {
  listCollections: async () => {
    return [...collections].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map(publicCollection);
  },
  // One level at a time: the folders directly under parentId (null = top).
  reorderCollections: async (collectionIds, parentId = null) => {
    const manual = collections.filter((c) => c.kind === "manual" && (c.parent_collection_id || null) === (parentId || null));
    if (collectionIds.length !== manual.length || new Set(collectionIds).size !== manual.length ||
        manual.some((c) => !collectionIds.includes(c.collection_id))) {
      throw new Error("Folder list changed; reload and try again");
    }
    const order = new Map(collectionIds.map((id, index) => [id, index]));
    for (const row of manual) row.sort_order = order.get(row.collection_id);
    emitCollectionsChanged();
    return { ok: true };
  },
  createCollection: async (name, kind = "manual", rules = null, parentId = null) => {
    const now = new Date().toISOString();
    const parent = parentId || null;
    if (parent && ((kind || "manual") !== "manual" || !folderRow(parent))) throw new Error("A folder can only be made inside another folder");
    const row = {
      collection_id: `webcol-${Date.now()}-${nextCollectionId++}`,
      name: String(name || "").trim() || "Untitled",
      kind: kind || "manual",
      parent_collection_id: parent,
      rules_json: null,
      rules: kind === "smart" && rules ? { version: 1, status: "all", search: "", filters: {}, ...rules } : null,
      // New folders go on top of their level's custom order, like the sidecar's.
      sort_order: (kind || "manual") === "manual"
        ? topOfLevel(parent)
        : Math.max(-1, ...collections.map((c) => c.sort_order || 0)) + 1,
      created_at: now,
      updated_at: now,
      asset_ids: [],
    };
    collections.push(row);

    emitCollectionsChanged();
    return publicCollection(row);
  },
  updateCollection: async (collectionId, updates = {}) => {
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return null;
    if (typeof updates.name === "string" && updates.name.trim()) row.name = updates.name.trim();
    if (Number.isInteger(updates.sortOrder)) row.sort_order = updates.sortOrder;
    if (row.kind === "smart" && updates.rules) row.rules = { version: 1, status: "all", search: "", filters: {}, ...updates.rules };
    row.updated_at = new Date().toISOString();

    emitCollectionsChanged();
    return publicCollection(row);
  },
  // Into another folder, or to the top level (parentId null); never into
  // itself or one of its own folders.
  moveCollection: async (collectionId, parentId = null) => {
    const row = folderRow(collectionId);
    if (!row) throw new Error("A smart collection cannot be moved into a folder");
    const parent = parentId || null;
    if (parent && (!folderRow(parent) || subtreeIds(collectionId).includes(parent))) {
      throw new Error("A folder cannot be moved into itself or into one of its own folders");
    }
    if ((row.parent_collection_id || null) === parent) return { collection_id: collectionId, parent_collection_id: parent, moved: false };
    row.parent_collection_id = parent;
    row.sort_order = topOfLevel(parent);
    row.updated_at = new Date().toISOString();
    emitCollectionsChanged();
    return { collection_id: collectionId, parent_collection_id: parent, moved: true };
  },
  // A folder's subfolders go with it; the photos stay.
  deleteCollection: async (collectionId) => {
    const deleted = subtreeIds(collectionId);
    for (const id of deleted) {
      const idx = collections.findIndex((c) => c.collection_id === id);
      if (idx >= 0) collections.splice(idx, 1);
    }
    emitCollectionsChanged();
    return { ok: true, collection_id: collectionId, deleted };
  },
  // The photos only these folders (and the folders under them) hold.
  collectionContents: async (collectionIds) => {
    const doomed = new Set((collectionIds || []).flatMap((id) => subtreeIds(id)));
    const inside = new Set();
    const elsewhere = new Set();
    for (const row of collections) {
      if (row.kind !== "manual") continue;
      for (const id of row.asset_ids || []) (doomed.has(row.collection_id) ? inside : elsewhere).add(id);
    }
    const photos = [...inside].filter((id) => !elsewhere.has(id)).map((id) => ({ asset_id: id, path: null }));
    return { folders: doomed.size, total: inside.size, shared: inside.size - photos.length, photos };
  },
  collectionAddItems: async (collectionId, assetIds) => {
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return { added: 0 };
    const have = new Set(row.asset_ids);
    const valid = new Set(assets.map((a) => a.asset_id));
    let added = 0;
    for (const id of assetIds || []) {
      if (valid.has(id) && !have.has(id)) { row.asset_ids.push(id); have.add(id); added += 1; }
    }
    if (added) {
      row.updated_at = new Date().toISOString();
      emitCollectionsChanged();
    }
    return { added };
  },
  collectionRemoveItems: async (collectionId, assetIds) => {
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return { removed: 0 };
    const drop = new Set(assetIds || []);
    const before = row.asset_ids.length;
    row.asset_ids = row.asset_ids.filter((id) => !drop.has(id));
    const removed = before - row.asset_ids.length;
    if (removed) {
      row.updated_at = new Date().toISOString();
      emitCollectionsChanged();
    }
    return { removed };
  },
};
