// Which entries the sidebar shows, and in what order: the user hides the
// ones they don't use, from an entry's right-click menu or from Settings ›
// General › Sidebar, and drags an entry or a section's heading to move it.
// Remembered choices of this Mac (utils/prefs.js), like the folds of the
// sections. All Assets can't be hidden or moved: it is the way back to the
// library, and it stays on top.

import { useEffect, useState } from "react";
import { readPref, writePref } from "../utils/prefs";

export const SIDEBAR_HIDDEN_PREF = "sidebar.hidden";
const CHANGED = "afterframe:sidebar-hidden";

// The entries that can be hidden, in the sidebar's own order before anyone
// moves them. A feature module's view (the sticker library) is named by its
// own id, between Look-alikes and People.
export const SIDEBAR_ENTRIES = Object.freeze([
  "discover", "recent", "rated", "lookalikes", "@views", "people", "tags", "stats",
  "smartCollections", "collections", "diskFolders",
]);
// The three sections under the entries. Entries move among entries, and
// sections among sections.
export const SIDEBAR_SECTIONS = Object.freeze(["smartCollections", "collections", "diskFolders"]);
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

// ---- Order -------------------------------------------------------------------

export const SIDEBAR_ORDER_PREF = "sidebar.order";
const ORDER_CHANGED = "afterframe:sidebar-order";

// The entries above the sections in their built-in order, with the feature
// views' ids (`viewIds`) in place of "@views".
export function defaultEntryOrder(viewIds = []) {
  return SIDEBAR_ENTRIES.flatMap((id) => (id === "@views" ? viewIds : SIDEBAR_SECTIONS.includes(id) ? [] : [id]));
}

// `ids` (a group in its built-in order) in the order the user left them:
// those `stored` names first, as it has them. One it doesn't name, an entry
// added since, goes after the one it follows in the built-in order; first if
// none does.
export function arranged(ids, stored) {
  const known = new Set(ids);
  const result = [];
  for (const id of stored || []) if (known.has(id) && !result.includes(id)) result.push(id);
  ids.forEach((id, index) => {
    if (result.includes(id)) return;
    const after = ids.slice(0, index).reverse().find((earlier) => result.includes(earlier));
    result.splice(after === undefined ? 0 : result.indexOf(after) + 1, 0, id);
  });
  return result;
}

// `order` with `id` moved before or after `target`. Unchanged when either
// isn't in it, or when they are the same.
export function moved(order, id, target, place) {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const rest = order.filter((entry) => entry !== id);
  rest.splice(rest.indexOf(target) + (place === "after" ? 1 : 0), 0, id);
  return rest;
}

export function readSidebarOrder() {
  return readPref(SIDEBAR_ORDER_PREF, [], isNameList);
}

// Both groups as the user has them: { entries, sections }.
export function sidebarOrder(stored, viewIds = []) {
  return { entries: arranged(defaultEntryOrder(viewIds), stored), sections: arranged([...SIDEBAR_SECTIONS], stored) };
}

// Moves `id` before or after `target` in its group and remembers both groups.
export function moveSidebarEntry(id, target, place, viewIds = []) {
  const { entries, sections } = sidebarOrder(readSidebarOrder(), viewIds);
  const next = [...moved(entries, id, target, place), ...moved(sections, id, target, place)];
  writePref(SIDEBAR_ORDER_PREF, next);
  window.dispatchEvent(new CustomEvent(ORDER_CHANGED, { detail: next }));
}

// The order as { entries, sections }, kept current when it changes.
export function useSidebarOrder(viewIds = []) {
  const [stored, setStored] = useState(() => readSidebarOrder());
  useEffect(() => {
    const onChange = (event) => setStored(event.detail || readSidebarOrder());
    window.addEventListener(ORDER_CHANGED, onChange);
    return () => window.removeEventListener(ORDER_CHANGED, onChange);
  }, []);
  return sidebarOrder(stored, viewIds);
}
