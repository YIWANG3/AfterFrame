// The user's keyboard shortcuts, live: the overrides saved in app settings
// (shared/shortcuts.mjs has the actions, defaults and binding format). One
// module-level copy, so the global key handler, the menu labels and Settings
// all read the same keys and re-render together when they change.

import { useSyncExternalStore } from "react";
import api from "../api";
import i18n from "../i18n";
import {
  SHORTCUT_ACTIONS,
  bindingsFor as bindingsForOverrides,
  defaultBindings,
  eventBinding,
  formatBinding,
  matchBinding,
  sanitizeOverrides,
} from "../../shared/shortcuts.mjs";

const platform = api.platform === "darwin" || api.platform === "win32" || api.platform === "linux"
  ? api.platform
  // The web build has no platform; a Mac browser gets ⌘, anything else Ctrl.
  : (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "") ? "darwin" : "other");

let overrides = {};
let version = 0;
const listeners = new Set();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeShortcuts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function shortcutPlatform() {
  return platform;
}

let loading = null;
export function loadShortcuts() {
  if (!loading) {
    loading = Promise.resolve(api.getShortcuts?.())
      .then((stored) => {
        overrides = sanitizeOverrides(stored, platform);
        notify();
      })
      .catch(() => {});
  }
  return loading;
}

export function shortcutOverrides() {
  return overrides;
}

export function bindingsFor(id) {
  return bindingsForOverrides(id, overrides, platform);
}

export function isDefault(id) {
  return !Object.prototype.hasOwnProperty.call(overrides, id);
}

// Saves the whole override map (main rebuilds the menu from it). A list equal
// to the defaults is dropped, so the action follows later default changes.
async function save(next) {
  const clean = {};
  for (const [id, list] of Object.entries(next)) {
    const defaults = defaultBindings(id, platform);
    if (list.length === defaults.length && list.every((binding, i) => binding === defaults[i])) continue;
    clean[id] = list;
  }
  overrides = sanitizeOverrides(clean, platform);
  notify();
  try {
    const persisted = await api.saveShortcuts?.(overrides);
    if (persisted && typeof persisted === "object") {
      overrides = sanitizeOverrides(persisted, platform);
      notify();
    }
  } catch {
    // Kept for this session; the next start reads what was last saved.
  }
}

// Gives `id` these keys, taking each one away from `takeFrom` (the actions the
// user agreed to take it over from).
export function setBindings(id, list, takeFrom = []) {
  const next = { ...overrides, [id]: list };
  for (const otherId of takeFrom) {
    next[otherId] = bindingsFor(otherId).filter((binding) => !list.includes(binding));
  }
  return save(next);
}

export function resetBindings(id) {
  const next = { ...overrides };
  delete next[id];
  return save(next);
}

export function resetAllBindings() {
  return save({});
}

// The action a keydown triggers among `scopes`: { id, advance } or null.
export function matchShortcut(event, scopes) {
  return matchBinding(eventBinding(event, platform), scopes, overrides, platform);
}

export function formatKeys(binding) {
  return formatBinding(binding, platform, { Space: i18n.t("settings:shortcuts.keys.space") });
}

// The label a menu or button shows for an action: its first key, or "".
export function shortcutLabel(id) {
  const first = bindingsFor(id)[0];
  return first ? formatKeys(first) : "";
}

// Re-renders the caller when the shortcuts change; returns the version.
export function useShortcuts() {
  return useSyncExternalStore(subscribeShortcuts, () => version, () => version);
}

export { SHORTCUT_ACTIONS };
