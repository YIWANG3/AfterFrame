// The sidebar's folder list: which manual folders show, in what order.
//
// "custom" is the order the user drags (sort_order, new folders on top); the
// others are computed, so dragging to reorder only makes sense under custom
// and with no search narrowing the list.
export const FOLDER_SORTS = ["custom", "name", "newest", "largest"];

// The comparator behind each sort; "custom" is the dragged order within a
// level (folderTree.js sorts each level with it).
export function folderComparator(sort = "custom", locale) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byName = (a, b) => collator.compare(a.name || "", b.name || "");
  return {
    custom: (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byName(a, b),
    name: byName,
    newest: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || byName(a, b),
    largest: (a, b) => (b.item_count || 0) - (a.item_count || 0) || byName(a, b),
  }[FOLDER_SORTS.includes(sort) ? sort : "custom"];
}

// Every folder, whatever its depth, as one flat list (the folder page's wall).
export function visibleFolders(collections, { sort = "custom", query = "", locale } = {}) {
  const needle = query.trim().toLocaleLowerCase(locale);
  const folders = (collections || []).filter((c) => c.kind === "manual"
    && (!needle || (c.name || "").toLocaleLowerCase(locale).includes(needle)));
  return [...folders].sort(folderComparator(sort, locale));
}

export function canReorderFolders({ sort = "custom", query = "" } = {}) {
  return sort === "custom" && !query.trim();
}
