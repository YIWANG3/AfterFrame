// The pure part of an optimistic asset write (useAssetMutations): a rating,
// a flag or a description is shown on the loaded records at once, written to
// the catalog, and put back if the write fails. What the records hold before
// and after is computed here, where it can be unit-tested without React.

// What a flag is stored as (sidecar db/assets.py FLAG_VALUES).
export const FLAG_VALUES = { pick: 1, reject: -1, none: 0 };

// The ids a mutation acts on: no blanks, no repeats, in the order given.
export function uniqueIds(assetIds) {
  return [...new Set((assetIds || []).filter(Boolean))];
}

// The fields `read` returns for each targeted record, keyed by asset id: the
// grid's rows and the Inspector's record alike (the latter need not be in the
// grid), the first occurrence of an id winning. A failed write is undone
// from this (rollbackPatch).
export function snapshotFields(records, targetSet, read) {
  const previous = new Map();
  for (const record of records) {
    if (!record || !targetSet.has(record.asset_id) || previous.has(record.asset_id)) continue;
    previous.set(record.asset_id, read(record));
  }
  return previous;
}

// The record with `patch(record)` applied when it is targeted; the same
// object otherwise, so an untouched row keeps its identity.
export function patchRecord(record, targetSet, patch) {
  return record && targetSet.has(record.asset_id) ? { ...record, ...patch(record) } : record;
}

export function patchList(list, targetSet, patch) {
  return list.map((record) => patchRecord(record, targetSet, patch));
}

// The patch that undoes an optimistic one: what the snapshot holds for the
// record, or nothing for a record loaded since.
export const rollbackPatch = (previous) => (record) => previous.get(record.asset_id) || {};

// ── the three writes ──

export const ratingFields = (record) => ({ app_rating: record.app_rating ?? null });
export const ratingPatch = (rating) => () => ({ app_rating: rating });

export const flagFields = (record) => ({ app_flag: record.app_flag ?? null });
export const flagPatch = (value) => () => ({ app_flag: value });

export const descriptionFields = (record) => ({
  description: record.description ?? null,
  description_source: record.description_source ?? null,
});

// The description as shown after the user's write: their text ("" leaves it
// empty, their choice), or with null the AI's caption again, where there is one.
export const descriptionPatch = (value) => (record) => {
  if (value !== null) return { description: value || null, description_source: "user" };
  const ai = (record.ai_caption || record.annotation?.caption || "").trim();
  return { description: ai || null, description_source: ai ? "ai" : null };
};

// The description value the catalog is sent: null hands the field back to
// the AI; anything else is trimmed text.
export function normalizeDescription(text) {
  return text === null ? null : String(text || "").trim();
}
