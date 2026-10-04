// The sidebar's folder list: which manual folders show, in what order.
//
// "custom" is the order the user drags (sort_order, new folders on top); the
// others are computed, so dragging to reorder only makes sense under custom
// and with no search narrowing the list.
export const FOLDER_SORTS = ["custom", "name", "newest", "largest"];

export function visibleFolders(collections, { sort = "custom", query = "", locale } = {}) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byName = (a, b) => collator.compare(a.name || "", b.name || "");
  const needle = query.trim().toLocaleLowerCase(locale);
  const folders = (collections || []).filter((c) => c.kind === "manual"
    && (!needle || (c.name || "").toLocaleLowerCase(locale).includes(needle)));
  const compare = {
    custom: (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byName(a, b),
    name: byName,
    newest: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || byName(a, b),
    largest: (a, b) => (b.item_count || 0) - (a.item_count || 0) || byName(a, b),
  }[FOLDER_SORTS.includes(sort) ? sort : "custom"];
  return [...folders].sort(compare);
}

export function canReorderFolders({ sort = "custom", query = "" } = {}) {
  return sort === "custom" && !query.trim();
}
