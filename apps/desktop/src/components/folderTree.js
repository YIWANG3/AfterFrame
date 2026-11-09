// Folders as a tree (collections.parent_collection_id, sidecar
// db/collections.py): which rows the sidebar shows and in what order, what
// sits under what, where a folder may be dropped, and the one flat list the
// pickers (the right-click submenu, the collage's source dropdown, the filter
// bar's folder facet) all draw from. Pure functions over the collection rows.
//
// Only manual folders take part; a folder whose parent is missing or is not
// a folder reads as top-level, so a stray row never hides a subtree.

import { FOLDER_SORTS, folderComparator } from "./folderList";

const isFolder = (c) => c?.kind === "manual";

// parentId (null for the top level) → its folders, unsorted.
export function folderChildren(collections) {
  const folders = (collections || []).filter(isFolder);
  const ids = new Set(folders.map((c) => c.collection_id));
  const children = new Map([[null, []]]);
  for (const folder of folders) {
    const parent = folder.parent_collection_id && ids.has(folder.parent_collection_id) ? folder.parent_collection_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(folder);
  }
  return children;
}

const byId = (collections) => new Map((collections || []).filter(isFolder).map((c) => [c.collection_id, c]));

// The folder's ancestors, nearest first; a cycle or a missing parent ends the walk.
export function ancestorIds(collections, collectionId) {
  const folders = byId(collections);
  const out = [];
  const seen = new Set([collectionId]);
  let parent = folders.get(collectionId)?.parent_collection_id || null;
  while (parent && folders.has(parent) && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    parent = folders.get(parent).parent_collection_id || null;
  }
  return out;
}

// Every folder under this one, depth-first, the folder itself excluded.
export function descendantIds(collections, collectionId) {
  const children = folderChildren(collections);
  const out = [];
  const walk = (id) => {
    for (const child of children.get(id) || []) {
      if (out.includes(child.collection_id)) continue;
      out.push(child.collection_id);
      walk(child.collection_id);
    }
  };
  walk(collectionId);
  return out;
}

// "Trips / Japan / Kyoto": the names from the top down to this folder.
export function pathOf(collections, collectionId) {
  const folders = byId(collections);
  const self = folders.get(collectionId);
  if (!self) return "";
  const names = ancestorIds(collections, collectionId).map((id) => folders.get(id).name).reverse();
  return [...names, self.name].join(" / ");
}

// The ancestors' names only ("Trips / Japan" for Kyoto), "" at the top level.
export function parentPathOf(collections, collectionId) {
  const folders = byId(collections);
  return ancestorIds(collections, collectionId).map((id) => folders.get(id).name).reverse().join(" / ");
}

// May `sourceId` be moved into `targetId`? Not into itself, not into
// anything under it, and only into a folder (null = the top level, always allowed).
export function canDropInto(collections, sourceId, targetId) {
  if (!sourceId) return false;
  if (targetId == null) return true;
  if (sourceId === targetId) return false;
  if (!byId(collections).has(targetId)) return false;
  return !descendantIds(collections, sourceId).includes(targetId);
}

// The tree flattened for the sidebar: {folder, depth, hasChildren, expanded}
// rows, each level in the chosen order, a collapsed folder's subtree left out.
// With a search, the folders whose name matches, at any depth, as one flat
// list in that order, each with `pathLabel` (its ancestors) so same-named
// folders can be told apart.
export function visibleTreeRows(collections, { sort = "custom", query = "", expanded, locale } = {}) {
  const compare = folderComparator(FOLDER_SORTS.includes(sort) ? sort : "custom", locale);
  const needle = query.trim().toLocaleLowerCase(locale);
  if (needle) {
    return (collections || [])
      .filter((c) => isFolder(c) && (c.name || "").toLocaleLowerCase(locale).includes(needle))
      .sort(compare)
      .map((folder) => ({ folder, depth: 0, hasChildren: false, expanded: false, pathLabel: parentPathOf(collections, folder.collection_id) }));
  }
  const children = folderChildren(collections);
  const isExpanded = (id) => (expanded instanceof Set ? expanded.has(id) : Array.isArray(expanded) ? expanded.includes(id) : !!expanded?.[id]);
  const rows = [];
  const seen = new Set();
  const walk = (parentId, depth) => {
    for (const folder of [...(children.get(parentId) || [])].sort(compare)) {
      if (seen.has(folder.collection_id)) continue;
      seen.add(folder.collection_id);
      const kids = children.get(folder.collection_id) || [];
      const open = kids.length > 0 && isExpanded(folder.collection_id);
      rows.push({ folder, depth, hasChildren: kids.length > 0, expanded: open, pathLabel: "" });
      if (open) walk(folder.collection_id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// Every folder, depth-first by name, with its depth — for menus and
// dropdowns, which indent by depth instead of nesting.
export function flattenForPicker(collections, { locale, sort = "name" } = {}) {
  const compare = folderComparator(sort, locale);
  const children = folderChildren(collections);
  const out = [];
  const seen = new Set();
  const walk = (parentId, depth) => {
    for (const folder of [...(children.get(parentId) || [])].sort(compare)) {
      if (seen.has(folder.collection_id)) continue;
      seen.add(folder.collection_id);
      out.push({ folder, depth });
      walk(folder.collection_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// The siblings of a folder (itself included), in custom order — what a
// reorder saves for its level.
export function siblingIds(collections, collectionId) {
  const folders = byId(collections);
  const self = folders.get(collectionId);
  if (!self) return [];
  const parent = self.parent_collection_id && folders.has(self.parent_collection_id) ? self.parent_collection_id : null;
  return [...(folderChildren(collections).get(parent) || [])].sort(folderComparator("custom")).map((c) => c.collection_id);
}

// The parent a folder effectively has in the tree (null at the top level).
export function parentIdOf(collections, collectionId) {
  const folders = byId(collections);
  const parent = folders.get(collectionId)?.parent_collection_id || null;
  return parent && folders.has(parent) ? parent : null;
}
