// Keyboard shortcuts: every action the user can rebind, its default keys, and
// the binding format the renderer (matching, labels, Settings) and main (menu
// accelerators) share. User changes are stored as overrides only: an action
// absent from them is on its defaults, so a default changed in a later version
// reaches everyone who never touched it.
//
// A binding is one string: modifiers in a fixed order, then the key's
// KeyboardEvent.code — "Mod+Shift+KeyP", "Backspace", "Digit3". Mod is ⌘ on
// macOS and Ctrl elsewhere; Ctrl is a modifier of its own only on macOS. The
// code is the physical key, so a binding works the same whatever Shift or an
// input method does to the character.

export const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

// Where an action listens. Two actions conflict when their keys are the same
// and their scopes can be live at once (SCOPE_OVERLAP).
//   global   — anywhere, the editor included
//   library  — the photo grid and the lightbox
//   gallery  — the photo grid only (lightbox closed)
//   lightbox — the lightbox only
//   editor   — the image editor
export const SCOPES = ["global", "library", "gallery", "lightbox", "editor"];
const SCOPE_OVERLAP = {
  global: ["global", "library", "gallery", "lightbox", "editor"],
  library: ["global", "library", "gallery", "lightbox"],
  gallery: ["global", "library", "gallery"],
  lightbox: ["global", "library", "lightbox"],
  editor: ["global", "editor"],
};
export function scopesOverlap(a, b) {
  return (SCOPE_OVERLAP[a] || []).includes(b);
}

// Groups, in the order Settings lists them.
export const SHORTCUT_GROUPS = ["cull", "organize", "browse", "lightbox", "app", "editor"];

// The rebindable actions, in display order within each group.
//   advance — holding Shift as well also moves to the next photo (Lightroom)
//   menu    — a native menu item carries the keys as its accelerator; such a
//             binding needs a modifier, or the menu would eat typed letters
//   desktop — only exists where there is a native menu (not the web build)
export const SHORTCUT_ACTIONS = [
  { id: "flag.pick", group: "cull", scope: "library", defaults: ["KeyP"], advance: true },
  { id: "flag.reject", group: "cull", scope: "library", defaults: ["KeyX"], advance: true },
  { id: "flag.none", group: "cull", scope: "library", defaults: ["KeyU"], advance: true },
  ...[0, 1, 2, 3, 4, 5].map((n) => ({
    id: `rating.${n}`, group: "cull", scope: "library", defaults: [`Digit${n}`], advance: true,
  })),

  { id: "photo.addTags", group: "organize", scope: "library", defaults: ["KeyT"] },
  { id: "photo.edit", group: "organize", scope: "library", defaults: ["KeyE"] },
  { id: "photo.compare", group: "organize", scope: "gallery", defaults: ["KeyC"] },
  { id: "photo.reveal", group: "organize", scope: "library", defaults: ["Mod+Enter"] },
  { id: "photo.delete", group: "organize", scope: "library", defaults: ["Backspace", "Delete"] },
  { id: "photo.deleteRejected", group: "organize", scope: "library", defaults: ["Mod+Backspace"] },

  { id: "select.all", group: "browse", scope: "gallery", defaults: ["Mod+KeyA"], menu: "edit:select-all" },
  { id: "select.none", group: "browse", scope: "gallery", defaults: ["Mod+KeyD"] },
  { id: "lightbox.toggle", group: "browse", scope: "library", defaults: ["Space"] },
  { id: "view.search", group: "browse", scope: "gallery", defaults: ["Mod+KeyF"] },
  { id: "view.filters", group: "browse", scope: "gallery", defaults: ["Backslash"] },
  { id: "view.map", group: "browse", scope: "gallery", defaults: ["KeyM"] },
  { id: "view.thumbLarger", group: "browse", scope: "gallery", defaults: ["Equal"] },
  { id: "view.thumbSmaller", group: "browse", scope: "gallery", defaults: ["Minus"] },

  { id: "lightbox.proof", group: "lightbox", scope: "lightbox", defaults: ["Mod+KeyP"] },

  { id: "app.settings", group: "app", scope: "global", defaults: ["Mod+Comma"], menu: "app:open-settings" },
  { id: "app.shortcuts", group: "app", scope: "global", defaults: ["Mod+Slash"] },
  { id: "catalog.new", group: "app", scope: "global", defaults: ["Mod+KeyN"], menu: "catalog:new", desktop: true },
  { id: "catalog.open", group: "app", scope: "global", defaults: ["Mod+KeyO"], menu: "catalog:open", desktop: true },
  { id: "import.run", group: "app", scope: "global", defaults: ["Mod+KeyI"], menu: "import:start", desktop: true },
  { id: "view.refresh", group: "app", scope: "global", defaults: ["Mod+KeyR"], menu: "view:refresh", desktop: true },
  {
    id: "view.fullscreen", group: "app", scope: "global", menu: "toggle-fullscreen", desktop: true,
    defaults: { darwin: ["Mod+Ctrl+KeyF"], other: ["F11"] },
  },

  { id: "editor.save", group: "editor", scope: "editor", defaults: ["Mod+KeyS"] },
];

const ACTION_BY_ID = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action]));
export function shortcutAction(id) {
  return ACTION_BY_ID.get(id) || null;
}

// Keys that are not the user's to give away: the operating system's own, the
// standard editing keys, and the fixed navigation keys. Settings lists them
// (read-only) so the page shows every key the app answers to.
export const FIXED_SHORTCUTS = [
  { id: "fixed.navigate", group: "browse", scope: "library", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] },
  { id: "fixed.close", group: "browse", scope: "global", keys: ["Escape"] },
  { id: "fixed.undo", group: "editor", scope: "editor", keys: ["Mod+KeyZ"] },
  { id: "fixed.redo", group: "editor", scope: "editor", keys: ["Mod+Shift+KeyZ"] },
  { id: "fixed.copyLayers", group: "editor", scope: "editor", keys: ["Mod+KeyC", "Mod+KeyV"] },
  { id: "fixed.deleteLayer", group: "editor", scope: "editor", keys: ["Delete", "Backspace"] },
  { id: "fixed.apply", group: "editor", scope: "editor", keys: ["Enter"] },
  { id: "fixed.pan", group: "editor", scope: "editor", keys: ["Space"] },
  { id: "fixed.copyPaste", group: "app", scope: "global", keys: ["Mod+KeyC", "Mod+KeyV", "Mod+KeyX"] },
  { id: "fixed.quit", group: "app", scope: "global", keys: ["Mod+KeyQ"], platforms: ["darwin"] },
];

// Never assignable, in any scope: system keys and keys text editing relies on.
const RESERVED_EVERYWHERE = new Set([
  "Escape", "Tab", "Shift+Tab", "Enter",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Mod+KeyC", "Mod+KeyV", "Mod+KeyX", "Mod+KeyZ", "Mod+Shift+KeyZ",
  "Mod+KeyQ", "Mod+KeyW", "Mod+KeyH", "Mod+KeyM", "Mod+Alt+KeyH", "Mod+Alt+KeyI",
]);

// Why `binding` can't go to `actionId` at all ("reserved", "needsModifier",
// "modifierOnly"), or null when it can. Conflicts with other actions are
// findConflicts' business: those the user may resolve by taking the keys over.
export function bindingProblem(binding, actionId, platform) {
  const parsed = parseBinding(binding);
  if (!parsed || !parsed.code) return "modifierOnly";
  if (RESERVED_EVERYWHERE.has(binding)) return "reserved";
  const action = shortcutAction(actionId);
  if (action) {
    for (const fixed of FIXED_SHORTCUTS) {
      if (!appliesOn(fixed, platform)) continue;
      if (fixed.keys.includes(binding) && scopesOverlap(fixed.scope, action.scope)) return "reserved";
    }
    // A menu accelerator without a modifier fires while typing in a text
    // field; global keys that aren't menu items are matched in the renderer,
    // which skips text fields only for keys without a modifier, so those need
    // one too or they could never be typed.
    const needsModifier = action.menu || action.scope === "global";
    if (needsModifier && !parsed.modifiers.length && !/^F\d{1,2}$/.test(parsed.code)) return "needsModifier";
  }
  return null;
}

function appliesOn(entry, platform) {
  return !entry.platforms || entry.platforms.includes(platform === "darwin" ? "darwin" : "other");
}

export function fixedShortcuts(platform) {
  return FIXED_SHORTCUTS.filter((entry) => appliesOn(entry, platform));
}

export function defaultBindings(actionOrId, platform) {
  const action = typeof actionOrId === "string" ? shortcutAction(actionOrId) : actionOrId;
  if (!action) return [];
  const { defaults } = action;
  if (Array.isArray(defaults)) return [...defaults];
  return [...(platform === "darwin" ? defaults.darwin : defaults.other)];
}

// ── binding strings ──────────────────────────────────────────────────────

export function parseBinding(binding) {
  if (typeof binding !== "string" || !binding) return null;
  const parts = binding.split("+");
  const code = parts.pop();
  const modifiers = parts;
  if (!modifiers.every((m) => MODIFIER_ORDER.includes(m))) return null;
  if (new Set(modifiers).size !== modifiers.length) return null;
  return { modifiers, code: code || null };
}

export function normalizeBinding(binding) {
  const parsed = parseBinding(binding);
  if (!parsed || !parsed.code || !isKnownCode(parsed.code)) return null;
  const mods = MODIFIER_ORDER.filter((m) => parsed.modifiers.includes(m));
  return [...mods, parsed.code].join("+");
}

const NAMED_CODES = new Set([
  "Space", "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote", "Backquote",
  "BracketLeft", "BracketRight", "Minus", "Equal",
]);
function isKnownCode(code) {
  return NAMED_CODES.has(code) || /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}

// event.code values that mean the same key as another: the number pad types
// what the top row does, so ratings work from either.
const CODE_ALIASES = {
  Numpad0: "Digit0", Numpad1: "Digit1", Numpad2: "Digit2", Numpad3: "Digit3", Numpad4: "Digit4",
  Numpad5: "Digit5", Numpad6: "Digit6", Numpad7: "Digit7", Numpad8: "Digit8", Numpad9: "Digit9",
  NumpadEnter: "Enter", NumpadAdd: "Equal", NumpadSubtract: "Minus", NumpadDecimal: "Period", NumpadDivide: "Slash",
};

// event.key → code, for the rare event without a code (some synthetic ones).
const KEY_TO_CODE = {
  " ": "Space", ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash", ";": "Semicolon",
  "'": "Quote", "`": "Backquote", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal",
};
const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn",
]);

function codeOf(event) {
  let code = event.code || "";
  if (CODE_ALIASES[code]) code = CODE_ALIASES[code];
  if (code && !MODIFIER_CODES.has(code)) return code;
  if (code) return null;
  const key = event.key || "";
  if (KEY_TO_CODE[key]) return KEY_TO_CODE[key];
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (NAMED_CODES.has(key) || /^F\d{1,2}$/.test(key)) return key;
  return null;
}

// The binding a keydown spells, or null for a lone modifier / a composing IME.
// `{ partial: true }` returns the modifiers alone too ("Mod+Shift+"), for the
// Settings recorder to show while the user is still holding them.
export function eventBinding(event, platform, { partial = false } = {}) {
  if (!event || event.isComposing || event.key === "Process") return null;
  const mac = platform === "darwin";
  const mods = [];
  if (mac ? event.metaKey : event.ctrlKey) mods.push("Mod");
  if (mac && event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  const code = codeOf(event);
  if (!code) return partial && mods.length ? `${mods.join("+")}+` : null;
  return [...mods, code].join("+");
}

// ── display ──────────────────────────────────────────────────────────────

const MAC_MODIFIER_GLYPHS = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Mod"]; // Apple's order
const PC_MODIFIER_NAMES = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const KEY_LABELS_MAC = {
  Enter: "↩", Backspace: "⌫", Delete: "⌦", Escape: "Esc", Tab: "⇥", Space: "Space",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘",
};
const KEY_LABELS_PC = {
  Enter: "Enter", Backspace: "Backspace", Delete: "Del", Escape: "Esc", Tab: "Tab", Space: "Space",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "PgUp", PageDown: "PgDn", Home: "Home", End: "End",
};
const PUNCTUATION_LABELS = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=",
};

function keyLabel(code, mac, names) {
  if (names?.[code]) return names[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (PUNCTUATION_LABELS[code]) return PUNCTUATION_LABELS[code];
  return (mac ? KEY_LABELS_MAC : KEY_LABELS_PC)[code] || code;
}

// "⇧⌘P" on macOS, "Ctrl+Shift+P" elsewhere. `names` overrides a key's label
// (the renderer passes the translated "Space"). A partial binding ("Mod+")
// shows its modifiers alone.
export function formatBinding(binding, platform, names) {
  const parsed = parseBinding(binding);
  if (!parsed) return "";
  const mac = platform === "darwin";
  if (mac) {
    const mods = MAC_MODIFIER_ORDER.filter((m) => parsed.modifiers.includes(m)).map((m) => MAC_MODIFIER_GLYPHS[m]).join("");
    return parsed.code ? `${mods}${keyLabel(parsed.code, true, names)}` : mods;
  }
  const mods = MODIFIER_ORDER.filter((m) => parsed.modifiers.includes(m)).map((m) => PC_MODIFIER_NAMES[m]);
  const unique = [...new Set(mods)];
  return parsed.code ? [...unique, keyLabel(parsed.code, false, names)].join("+") : unique.map((m) => `${m}+`).join("");
}

// ── Electron accelerators ────────────────────────────────────────────────

const ACCELERATOR_KEYS = {
  Enter: "Return", Space: "Space", Backspace: "Backspace", Delete: "Delete", Escape: "Escape", Tab: "Tab",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=",
};
const ACCELERATOR_MODIFIERS = { Mod: "CmdOrCtrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };

export function toAccelerator(binding) {
  const parsed = parseBinding(binding);
  if (!parsed?.code) return null;
  let key = ACCELERATOR_KEYS[parsed.code];
  if (!key && /^Key[A-Z]$/.test(parsed.code)) key = parsed.code.slice(3);
  if (!key && /^Digit[0-9]$/.test(parsed.code)) key = parsed.code.slice(5);
  if (!key && /^F\d{1,2}$/.test(parsed.code)) key = parsed.code;
  if (!key) return null;
  const mods = MODIFIER_ORDER.filter((m) => parsed.modifiers.includes(m)).map((m) => ACCELERATOR_MODIFIERS[m]);
  return [...mods, key].join("+");
}

// ── overrides ────────────────────────────────────────────────────────────

// Stored overrides, checked: known actions only, each a list of valid,
// assignable, de-duplicated bindings (an empty list means "no keys").
export function sanitizeOverrides(raw, platform) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, list] of Object.entries(raw)) {
    if (!ACTION_BY_ID.has(id) || !Array.isArray(list)) continue;
    const clean = [];
    for (const binding of list.slice(0, 4)) {
      const normalized = normalizeBinding(binding);
      if (normalized && !bindingProblem(normalized, id, platform) && !clean.includes(normalized)) clean.push(normalized);
    }
    out[id] = clean;
  }
  return out;
}

export function bindingsFor(id, overrides, platform) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
  return defaultBindings(id, platform);
}

// The other actions already answering to `binding` in a scope that can be
// live with `actionId`'s. Holding Shift on an "advance" action's key counts
// as a binding of its own (do it and go to the next photo).
export function findConflicts(binding, actionId, overrides, platform) {
  const action = shortcutAction(actionId);
  if (!action) return [];
  const conflicts = [];
  for (const other of SHORTCUT_ACTIONS) {
    if (other.id === actionId || !scopesOverlap(other.scope, action.scope)) continue;
    const keys = bindingsFor(other.id, overrides, platform);
    const taken = keys.includes(binding)
      || (other.advance && keys.some((key) => shiftedBinding(key) === binding))
      || (action.advance && keys.includes(shiftedBinding(binding)));
    if (taken) conflicts.push(other.id);
  }
  return conflicts;
}

// "KeyP" → "Shift+KeyP"; null when the binding already holds Shift.
export function shiftedBinding(binding) {
  const parsed = parseBinding(binding);
  if (!parsed?.code || parsed.modifiers.includes("Shift")) return null;
  return normalizeBinding([...parsed.modifiers, "Shift", parsed.code].join("+"));
}

// Which action a keydown triggers among `scopes`, or null. An exact match
// wins; failing that, Shift on an advance action's key is that action plus
// "go to the next photo".
export function matchBinding(binding, scopes, overrides, platform) {
  if (!binding) return null;
  const live = SHORTCUT_ACTIONS.filter((action) => scopes.includes(action.scope));
  for (const action of live) {
    if (bindingsFor(action.id, overrides, platform).includes(binding)) return { id: action.id, advance: false };
  }
  const parsed = parseBinding(binding);
  if (parsed?.code && parsed.modifiers.includes("Shift")) {
    const unshifted = normalizeBinding([...parsed.modifiers.filter((m) => m !== "Shift"), parsed.code].join("+"));
    for (const action of live) {
      if (action.advance && bindingsFor(action.id, overrides, platform).includes(unshifted)) return { id: action.id, advance: true };
    }
  }
  return null;
}

// The accelerator a menu item shows for `menuId`, from the stored overrides.
export function menuAccelerator(menuId, overrides, platform) {
  const action = SHORTCUT_ACTIONS.find((entry) => entry.menu === menuId);
  if (!action) return undefined;
  const first = bindingsFor(action.id, sanitizeOverrides(overrides, platform), platform)[0];
  return first ? toAccelerator(first) || undefined : undefined;
}
