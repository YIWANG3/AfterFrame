// The decisions useWorkspace makes that don't need React: how a browse scope
// is keyed, what the local search projection matches, which selection
// survives a reload, when a reveal has to widen its scope. Pure so they can be
// unit-tested — the hook itself (1100 lines of state, refs and request
// races) is only covered by E2E, and two of the bugs in the 2026-09-16 review
// lived in exactly this logic.

export const browseScopeKey = ({ status, collectionId, search, sort, filters }) => JSON.stringify({
  status, collectionId: collectionId || null, search: search || "", sort, filters: filters || {},
});

// The gallery's browse destination, as one value. Everything that decides
// what the grid shows lives here — never in separate pieces of state that an
// async caller could read half-updated.
// `smartCollectionId` only says which saved filter the scope was opened from
// (sidebar highlight, "Update" in the filter bar). It is NOT part of the browse
// key: what the grid shows is decided by status/query/filters alone.
export const DEFAULT_SCOPE = Object.freeze({
  status: "all", collectionId: null, smartCollectionId: null, query: "", filters: {}, sort: "imported-desc",
});

export const scopeKeyOf = (scope) => browseScopeKey({
  status: scope.status,
  collectionId: scope.collectionId,
  search: scope.query.trim() || undefined,
  sort: scope.sort,
  filters: scope.filters,
});

// ── smart collections: a saved scope ─────────────────────────────────────
// The map viewport is where the user happens to be looking, not a condition.
const savableFilters = (filters) => Object.fromEntries(
  Object.entries(filters || {}).filter(([key, value]) => key !== "geo" && value != null && value !== ""),
);

// What a scope would save as. null when there is nothing to save: a manual
// folder is membership, not a filter, and an unfiltered library has no condition.
export function rulesFromScope(scope) {
  if (!scope || scope.collectionId) return null;
  const rules = { status: scope.status || "all", search: (scope.query || "").trim(), filters: savableFilters(scope.filters) };
  if (rules.status === "all" && !rules.search && !Object.keys(rules.filters).length) return null;
  return rules;
}

// The scope a smart collection opens as. The current sort is kept: how the
// user likes the grid ordered is theirs, not the collection's.
export function scopeFromRules(collection, currentSort) {
  const rules = collection?.rules;
  if (!rules) return null;
  return {
    status: rules.status || "all",
    collectionId: null,
    smartCollectionId: collection.collection_id,
    query: rules.search || "",
    filters: { ...(rules.filters || {}) },
    sort: currentSort || DEFAULT_SCOPE.sort,
  };
}

const stable = (value) => JSON.stringify(value, (_key, v) => (
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v
));

// Has the user changed the conditions since opening this smart collection?
export function rulesDirty(scope, rules) {
  if (!rules) return false;
  const current = rulesFromScope(scope);
  if (!current) return true;
  return stable(current) !== stable({ status: rules.status || "all", search: rules.search || "", filters: savableFilters(rules.filters) });
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
