// Opened from inside a folder, what a tool makes there — an edited copy, split
// panels, an AI repaint, a collage — can join that folder. One choice for all
// of them, remembered across sessions; it starts on, since the folder is what
// the user was working in. The box itself is ui's Checkbox, next to each
// save/export button.

import { useEffect, useState } from "react";

const KEY = "afterframe-add-to-folder";
// The collage had the box first, under its own key: an "off" set there still
// counts until the box is changed again.
const LEGACY_COLLAGE_KEY = "afterframe-collage-add-to-folder";

export function readAddToFolder() {
  const stored = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_COLLAGE_KEY);
  return stored !== "0";
}

export function writeAddToFolder(checked) {
  localStorage.setItem(KEY, checked ? "1" : "0");
}

// `sourceCollectionId` is the folder that was open when the tool opened; it
// only counts while it is still a folder (not deleted, not a smart collection).
export function useAddToFolder({ open, collections, sourceCollectionId, onAddToCollection }) {
  const [checked, setChecked] = useState(readAddToFolder);
  // Re-read on open: another tool may have changed it since.
  useEffect(() => {
    if (open) setChecked(readAddToFolder());
  }, [open]);
  const folder = sourceCollectionId
    ? (collections || []).find((c) => c.collection_id === sourceCollectionId && c.kind === "manual") || null
    : null;

  function setAddToFolder(next) {
    setChecked(next);
    writeAddToFolder(next);
  }

  // Registered results join the folder when the box is ticked. A failure here
  // is not a save failure: the file is saved and registered either way.
  async function joinFolder(assetIds) {
    const ids = (assetIds || []).filter(Boolean);
    if (!checked || !folder || !ids.length) return;
    try {
      await onAddToCollection?.(folder.collection_id, ids);
    } catch (err) {
      console.error("[addToFolder] adding to the folder failed:", err);
    }
  }

  return {
    folder,
    addToFolder: checked,
    setAddToFolder,
    joinFolder,
    // The folder a background job should put its result in, if any.
    targetCollectionId: checked && folder ? folder.collection_id : null,
  };
}
