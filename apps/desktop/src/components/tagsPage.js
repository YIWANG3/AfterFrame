// The Tags page's pure logic: which tags show, in which order, under which
// group. The component (TagsView.jsx) only draws what these return.

export const TAG_PAGE_SORTS = ["usage", "name"];
export const DEFAULT_TAG_PAGE_SORT = "usage";

const compareBy = (sort, locale, labelOf) => (a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (sort === "name") return labelOf(a.tag).localeCompare(labelOf(b.tag), locale);
  return (b.count - a.count) || labelOf(a.tag).localeCompare(labelOf(b.tag), locale);
};

// A tag matches a query by its name, its shown label or any alias.
export function tagMatches(entry, query, labelOf) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return [entry.tag, labelOf(entry.tag), ...(entry.aliases || [])].some((text) => String(text).toLowerCase().includes(q));
}

// The sections of the page: every group in order (an empty group still shows,
// so it can be renamed or deleted, unless a search hides it), the ungrouped
// last. `listed` is the sidecar's list-tags answer.
export function tagSections(listed, { query = "", sort = DEFAULT_TAG_PAGE_SORT, locale, labelOf = String } = {}) {
  const compare = compareBy(sort, locale, labelOf);
  const searching = String(query || "").trim().length > 0;
  const sections = [];
  for (const group of listed?.groups || []) {
    const items = (group.tags || []).filter((entry) => tagMatches(entry, query, labelOf)).sort(compare);
    if (searching && !items.length) continue;
    sections.push({ group, items });
  }
  const ungrouped = (listed?.ungrouped || []).filter((entry) => tagMatches(entry, query, labelOf)).sort(compare);
  if (ungrouped.length || !searching) sections.push({ group: null, items: ungrouped });
  return sections;
}

// Every tag the page lists, flat, for select-all and counts.
export function allTags(listed) {
  return [...(listed?.groups || []).flatMap((group) => group.tags || []), ...(listed?.ungrouped || [])];
}
