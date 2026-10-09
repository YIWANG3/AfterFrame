// Remembered choices: what a tool was last set to — the collage's gap, the
// text tool's font, the split's panel ratio — so the next time it opens it
// starts there instead of at the built-in default. Global to this Mac, like
// the theme and the pane widths (docs/settings-scope.md), and kept in
// localStorage: no IPC, and the web build behaves the same.
//
// Every read goes through a check. A value written by an older version, one
// whose range has since changed, a font that was uninstalled: whatever the
// check does not accept falls back to the default, so a stale preference can
// never break a tool. A check returns the value to use (possibly clamped) or
// undefined to reject it.

const PREFIX = "afterframe.pref.";

export function readPref(key, fallback, check = (value) => value) {
  let raw = null;
  try { raw = localStorage.getItem(PREFIX + key); } catch { /* storage blocked */ }
  if (raw == null) return fallback;
  try {
    const value = check(JSON.parse(raw));
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}

// Back to the built-in default: forget the value rather than store the
// default, so a later version can still change that default.
export function clearPref(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing stored */ }
}

// ── checks ──

export const oneOf = (values) => (value) => (values.includes(value) ? value : undefined);

export const numberIn = (min, max) => (value) => (
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined
);

export const intIn = (min, max) => (value) => (
  Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : undefined
);

export const bool = (value) => (typeof value === "boolean" ? value : undefined);

export const hexColor = (value) => (
  typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : undefined
);

export const text = (maxLength) => (value) => (typeof value === "string" ? value.slice(0, maxLength) : undefined);

// An object whose fields each have their own check. A field that fails is
// dropped, so the caller's default fills it; the others are kept.
export const fields = (checks) => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, check] of Object.entries(checks)) {
    if (!Object.hasOwn(value, key)) continue;
    const checked = check(value[key]);
    if (checked !== undefined) out[key] = checked;
  }
  return out;
};

// A map with string keys (an image count, a provider id) and checked values.
export const recordOf = (check, maxEntries = 64) => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, maxEntries)) {
    const checked = check(entry);
    if (checked !== undefined) out[key] = checked;
  }
  return out;
};
