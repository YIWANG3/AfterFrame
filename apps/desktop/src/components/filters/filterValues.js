// A facet's value as the filters object stores it, and the small helpers
// every popover edits it with.

export function setOrDelete(obj, key, value) {
  const next = { ...obj };
  if (value === undefined || value === null || value === "") delete next[key];
  else next[key] = value;
  return next;
}

export function fmtNum(v, decimals) {
  return decimals ? Number(v).toFixed(decimals) : String(Math.round(Number(v)));
}

// A facet's value: nothing, one pick (a scalar, as it has always been stored),
// or several (a list). Several values within one facet are OR.
export const toList = (value) => (value == null || value === "" ? [] : Array.isArray(value) ? value : [value]);

export const fromList = (list) => (list.length === 0 ? undefined : list.length === 1 ? list[0] : list);

export const sameOption = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
