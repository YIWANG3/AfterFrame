// Zero-dependency numeric helpers. The pure geometry modules under
// components/editor import from here; utils/format.js (which pulls in the api
// client) re-exports them for the components that already import it.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Two digits, for dates and numbered file names: 7 → "07".
export const pad2 = (n) => String(n).padStart(2, "0");
