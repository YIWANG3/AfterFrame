// The target folder: where B puts the selected photos (Lightroom's target
// collection). It is the folder the user last made or last added photos to,
// by any means — the field in the sidebar, a drop, the context menu, the key
// itself. Remembered per catalog, so it survives a restart; it only counts
// while it is still a folder (not deleted, not a smart collection).

const PREFIX = "afterframe-target-folder:";

export function readTargetFolderId(catalogKey) {
  if (!catalogKey) return null;
  try {
    return localStorage.getItem(PREFIX + catalogKey) || null;
  } catch {
    return null;
  }
}

export function writeTargetFolderId(catalogKey, collectionId) {
  if (!catalogKey) return;
  try {
    if (collectionId) localStorage.setItem(PREFIX + catalogKey, collectionId);
    else localStorage.removeItem(PREFIX + catalogKey);
  } catch {
    // Storage blocked: the target lasts this session.
  }
}

// The folder `collectionId` names among `collections`, or null.
export function resolveTargetFolder(collections, collectionId) {
  if (!collectionId) return null;
  return (collections || []).find((c) => c.collection_id === collectionId && c.kind === "manual") || null;
}
