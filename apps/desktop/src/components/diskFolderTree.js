// Folders on disk in the sidebar (DiskFolders.jsx): pure helpers over the
// sidecar's flat rows ({path, name, parent, volume, direct, total, exists},
// db/folders.py list_folders), kept apart so they can be tested.
// docs/collections-and-folders-design.md §5.

const SEPARATOR = /[\\/]/;

// The last part of a path: what a folder is called.
export function folderName(path) {
  const parts = String(path || "").split(SEPARATOR).filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

// `child` is `parent` or inside it.
export function isWithin(child, parent) {
  if (!child || !parent) return false;
  const a = String(child).replace(/[\\/]+$/, "");
  const b = String(parent).replace(/[\\/]+$/, "");
  if (a === b) return true;
  return a.startsWith(b) && SEPARATOR.test(a.charAt(b.length));
}

// Auto-sync is a watched folder (electron/watcher.js): a folder is synced
// when it, or a folder above it, is watched.
export const isSynced = (path, watchedDirs = []) => (watchedDirs || []).some((dir) => isWithin(path, dir));

// The folders the given one holds directly.
export function childrenOf(folders, path) {
  return (folders || []).filter((folder) => folder.parent === path);
}

export const hasChildren = (folders, path) => (folders || []).some((folder) => folder.parent === path);

// The folders above `path` in the tree, nearest first.
export function ancestorsOf(folders, path) {
  const byPath = new Map((folders || []).map((folder) => [folder.path, folder]));
  const out = [];
  let current = byPath.get(path)?.parent ?? null;
  while (current && !out.includes(current)) {
    out.push(current);
    current = byPath.get(current)?.parent ?? null;
  }
  return out;
}

// The rows the sidebar shows: the tree depth-first in the sidecar's order,
// a folder's children only while it is expanded. A volume heading starts
// each volume's folders when there is more than one volume or the one there
// is not the startup disk ({kind:"volume", volume}); else just folders
// ({kind:"folder", folder, depth, expandable, expanded}).
export function visibleRows(folders, expanded) {
  const list = folders || [];
  const open = expanded instanceof Set ? expanded : new Set(expanded || []);
  const volumes = [...new Set(list.map((folder) => folder.volume || ""))];
  const headed = volumes.length > 1 || (volumes.length === 1 && volumes[0] !== "");
  const children = new Map();
  for (const folder of list) {
    const key = folder.parent ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(folder);
  }
  const rows = [];
  let lastVolume = null;
  const walk = (folder, depth) => {
    const kids = children.get(folder.path) || [];
    const isOpen = open.has(folder.path);
    rows.push({ kind: "folder", folder, depth, expandable: kids.length > 0, expanded: isOpen && kids.length > 0 });
    if (isOpen) for (const kid of kids) walk(kid, depth + 1);
  };
  for (const top of children.get(null) || []) {
    const volume = top.volume || "";
    if (headed && volume !== lastVolume) rows.push({ kind: "volume", volume });
    lastVolume = volume;
    walk(top, 0);
  }
  return rows;
}
