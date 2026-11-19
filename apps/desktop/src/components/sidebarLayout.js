// Which entries the sidebar shows: the user hides the ones they don't use,
// from an entry's right-click menu or from Settings › General › Sidebar. A
// remembered choice of this Mac (utils/prefs.js), like the folds of the
// sections. All Assets can't be hidden: it is the way back to the library.

import { useEffect, useState } from "react";
import { readPref, writePref } from "../utils/prefs";

export const SIDEBAR_HIDDEN_PREF = "sidebar.hidden";
const CHANGED = "afterframe:sidebar-hidden";

// The entries that can be hidden, in the sidebar's order. A feature module's
// view (the sticker library) is named by its own id, between Discover and People.
export const SIDEBAR_ENTRIES = Object.freeze([
  "recent", "rated", "lookalikes", "discover", "@views", "people", "tags", "stats",
  "smartCollections", "collections", "diskFolders",
]);
const NEVER_HIDDEN = new Set(["all"]);

const isNameList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined);

export function readSidebarHidden() {
  return readPref(SIDEBAR_HIDDEN_PREF, [], isNameList);
}

// The list with `id` hidden or shown again: no duplicates, never All Assets.
export function withHidden(list, id, hidden) {
  const rest = (list || []).filter((entry) => entry !== id);
  return hidden && !NEVER_HIDDEN.has(id) ? [...rest, id] : rest;
}

export function setSidebarHidden(id, hidden) {
  const next = withHidden(readSidebarHidden(), id, hidden);
  writePref(SIDEBAR_HIDDEN_PREF, next);
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }));
}

// The hidden entries as a Set, kept current when Settings or a menu changes them.
export function useSidebarHidden() {
  const [hidden, setHidden] = useState(() => new Set(readSidebarHidden()));
  useEffect(() => {
    const onChange = (event) => setHidden(new Set(event.detail || readSidebarHidden()));
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);
  return hidden;
}

// Settings › General › Sidebar opens from an entry's "Customize Sidebar…".
export function openSidebarSettings() {
  window.dispatchEvent(new CustomEvent("afterframe:open-settings", { detail: { tab: "general" } }));
}
