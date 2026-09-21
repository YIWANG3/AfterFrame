// The decisions useWorkspace makes that don't need React: how a browse scope
// is keyed, what the local search projection matches, which selection
// survives a reload, when a reveal has to widen its scope. Pure so they can be
// unit-tested — the hook itself (1100 lines of state, refs and request
// races) is only covered by E2E, and two of the bugs in the 2026-09-16 review
// lived in exactly this logic.

export const browseScopeKey = ({ status, collectionId, search, sort, filters, base }) => JSON.stringify({
  status, collectionId: collectionId || null, search: search || "", sort, filters: filters || {}, base: base || null,
});

// The gallery's browse destination, as one value. Everything that decides
// what the grid shows lives here — never in separate pieces of state that an
// async caller could read half-updated.
//
// Two layers (docs/next-features-plan.md §D, sidecar db/browse.py):
//   WHERE the user is    status | collectionId | base (a smart collection's
//                        rules) — picks the base set.
//   the refinement       query + filters — what the filter bar and the search
//                        box hold. It only ever narrows INSIDE the base set,
//                        and changing location clears it.
// `smartCollectionId` names the smart collection (sidebar highlight, title).
// `editingRules`: the filter bar is showing that collection's OWN conditions
// for editing, instead of a refinement on top of them; `base` is then only
// the nested part of its rules, which the bar cannot show.
export const DEFAULT_SCOPE = Object.freeze({
  status: "all", collectionId: null, smartCollectionId: null, base: null, editingRules: false,
  query: "", filters: {}, sort: "imported-desc",
});

export const scopeKeyOf = (scope) => browseScopeKey({
  status: scope.status,
  collectionId: scope.collectionId,
  search: scope.query.trim() || undefined,
  sort: scope.sort,
  filters: scope.filters,
  base: scope.base,
});

// "Most recently added" only means something inside a folder.
export const COLLECTION_SORTS = ["added-desc", "added-asc"];
export const sortOutsideFolder = (sort) => (COLLECTION_SORTS.includes(sort) ? DEFAULT_SCOPE.sort : sort);

// Is the user narrowing the place they are in? Drives "the filter bar cannot be
// hidden while it is filtering" and which actions the bar offers.
export const hasRefinement = (scope) => !!scope.query.trim()
  || Object.entries(scope.filters || {}).some(([key, value]) => key !== "tag_match" && !isEmptyValue(value));

// The view facet counts are taken inside (db/browse.py _facet_scope): what
// the grid is showing, minus the sort, which does not change any count.
export const facetScopeOf = (scope) => ({
  collectionId: scope.collectionId || undefined,
  status: scope.collectionId || scope.base ? undefined : scope.status,
  search: scope.query.trim() || undefined,
  filters: scope.filters && Object.keys(scope.filters).length ? scope.filters : undefined,
  base: scope.collectionId ? undefined : scope.base || undefined,
});

// ── smart collections ─────────────────────────────────────────────────────
// The map viewport is where the user happens to be looking, not a condition.
// A facet value may be a list (several values within one facet are OR); an
// empty list is no condition. tag_match only tunes `tag` and means nothing alone.
const isEmptyValue = (value) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
const savableFilters = (filters) => {
  const kept = Object.fromEntries(Object.entries(filters || {}).filter(([key, value]) => key !== "geo" && !isEmptyValue(value)));
  if (!Array.isArray(kept.tag)) delete kept.tag_match;
  return kept;
};

// What the current view would save as: where the user is, plus the refinement.
//   a status view      → {status, search, filters}
//   a folder           → the refinement + in_collection (it follows the folder)
//   a smart collection → the refinement ON its rules: {…, base: rules}. Nested,
//                        not merged: both layers may hold the same key.
//   editing one        → the bar IS its top layer: {status, search, filters, base?}
// null when there is nothing to save (no refinement, or the plain library).
export function rulesFromScope(scope) {
  if (!scope) return null;
  const search = (scope.query || "").trim();
  const filters = savableFilters(scope.filters);
  const refined = !!search || Object.keys(filters).length > 0;
  if (scope.collectionId) {
    return refined ? { status: "all", search, filters: { ...filters, in_collection: scope.collectionId } } : null;
  }
  if (scope.base && !scope.editingRules) {
    return refined ? { status: "all", search, filters, base: scope.base } : null;
  }
  const rules = { status: scope.status || "all", search, filters };
  if (scope.base) rules.base = scope.base;
  if (rules.status === "all" && !refined && !rules.base) return null;
  return rules;
}

// Opening a smart collection: its rules become the base set, and the filter
// bar starts EMPTY — picking a format in there narrows the collection, it does
// not rewrite it. The sort is the user's, not the collection's.
export function scopeFromRules(collection, currentSort) {
  if (!collection?.rules) return null;
  return {
    ...DEFAULT_SCOPE,
    smartCollectionId: collection.collection_id,
    base: collection.rules,
    sort: sortOutsideFolder(currentSort || DEFAULT_SCOPE.sort),
  };
}

// Editing a smart collection's conditions: the bar shows its top layer. A
// nested base stays applied underneath; the bar has no way to show it.
export function editScopeFromRules(collection, currentSort) {
  const rules = collection?.rules;
  if (!rules) return null;
  return {
    ...DEFAULT_SCOPE,
    status: rules.status || "all",
    smartCollectionId: collection.collection_id,
    base: rules.base || null,
    editingRules: true,
    query: rules.search || "",
    filters: { ...(rules.filters || {}) },
    sort: sortOutsideFolder(currentSort || DEFAULT_SCOPE.sort),
  };
}

// Key order and the order options were ticked in are not differences.
const stable = (value) => JSON.stringify(value, (_key, v) => {
  if (Array.isArray(v)) return [...v].sort((a, b) => String(a).localeCompare(String(b)));
  return v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;
});
const comparable = (rules) => (rules ? {
  status: rules.status || "all", search: rules.search || "", filters: savableFilters(rules.filters), base: rules.base ? comparable(rules.base) : null,
} : null);

// While editing: do the bar's conditions differ from what is saved?
export function rulesDirty(scope, rules) {
  if (!rules || !scope?.editingRules) return false;
  return stable(comparable(rulesFromScope(scope))) !== stable(comparable(rules));
}

// Fields the client narrows on while the 250ms search debounce is pending.
// This MUST stay a superset of what the sidecar's `_search_clause`
// (db/browse.py) matches — filename/path, camera, lens, AI caption, OCR text
// and tags — because the projection also runs over the server's result. It
// once omitted caption/OCR/tags/lens, so an annotation-only hit came back from
// the sidecar and was filtered out here, leaving the gallery blank. Add every
// field the server learns to match on.
export function searchableFields(item) {
  return [
    item.stem,
    item.primary_stem,
    item.image_path,
    item.raw_path,
    item.version_kind,
    item.image_metadata?.camera_model,
    item.raw_metadata?.camera_model,
    item.image_metadata?.lens_model,
    item.raw_metadata?.lens_model,
    item.annotation?.caption,
    item.annotation?.detected_text,
    ...(item.annotation?.tags || []),
  ];
}

export function itemMatchesQuery(item, normalizedQuery) {
  return searchableFields(item).some((field) => String(field ?? "").toLowerCase().includes(normalizedQuery));
}

// Same array back when there is nothing to filter, so memo consumers don't
// re-render for an identity change.
export function filterItemsByQuery(items, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => itemMatchesQuery(item, normalizedQuery));
}

// After a fresh (non-append) browse page lands, which asset should be selected?
//   relatedPinned  — a version picked from the inspector stays selected even
//                    when it's outside this filtered page; the next ordinary
//                    gallery click clears the pin.
//   still on page  — keep it.
//   preserveView   — a background refresh never steals the selection by
//                    jumping to the first tile; it only clears when the asset
//                    truly disappeared.
//   otherwise      — the page's first asset (or null for an empty page).
export function chooseSelectionAfterReload({ payload, activeSelectedId, relatedPinned, preserveView }) {
  if (relatedPinned && activeSelectedId) return activeSelectedId;
  const stillValid = !!activeSelectedId && payload.some((item) => item.asset_id === activeSelectedId);
  if (stillValid) return activeSelectedId;
  if (preserveView) return null;
  return payload[0]?.asset_id || null;
}

// A related-version reveal must fall back to the unfiltered library when the
// target isn't in the current scope at all — or when it IS on the server's
// page but the local text projection would hide it (an annotation-only match
// on a filename-only query).
export function shouldResetScopeForReveal({ locationIndex, query, items, filteredItems, assetId }) {
  if (locationIndex == null) return true;
  const hasQuery = !!String(query || "").trim();
  const loaded = items.some((item) => item.asset_id === assetId);
  const visible = filteredItems.some((item) => item.asset_id === assetId);
  return hasQuery && loaded && !visible;
}
