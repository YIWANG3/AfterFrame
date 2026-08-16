/**
 * Pure grouping helpers for batch collage mode.
 *
 * A "page" is one output collage: a consecutive slice of the (ordered) image
 * pool. Grouping is always derived, never stored — UI state only keeps the
 * knobs (groupSize / orderBy / remainderMode).
 */

// Largest image count the template library covers. Merged remainder groups
// beyond this would silently drop images at render time, so computeGroups
// falls back to a separate page instead.
export const MAX_TEMPLATE_COUNT = 12;

export const GROUP_SIZE_OPTIONS = [2, 3, 4, 6, 9];

function captureTime(item) {
  return item?.image_metadata?.capture_time
    || item?.raw_metadata?.capture_time
    || null;
}

function nameKey(item) {
  return (item?.stem || item?.image_path || "").toLowerCase();
}

export function orderImages(images, orderBy) {
  if (orderBy === "captureTime") {
    return [...images].sort((a, b) => {
      const ta = captureTime(a);
      const tb = captureTime(b);
      if (ta && tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
      if (ta) return -1; // items without capture time sort last
      if (tb) return 1;
      return nameKey(a) < nameKey(b) ? -1 : 1;
    });
  }
  if (orderBy === "filename") {
    return [...images].sort((a, b) => (nameKey(a) < nameKey(b) ? -1 : 1));
  }
  return images; // "selection": keep as-is
}

/**
 * Split ordered images into pages of groupSize.
 * remainderMode: "own" (remainder gets its own page), "merge" (append to the
 * last full page), "drop" (remainder unused).
 */
export function computeGroups(images, groupSize, remainderMode) {
  const size = Math.max(1, groupSize);
  const groups = [];
  for (let i = 0; i < images.length; i += size) {
    groups.push(images.slice(i, i + size));
  }
  if (groups.length === 0) return groups;
  const last = groups[groups.length - 1];
  if (last.length < size) {
    if (remainderMode === "drop") {
      groups.pop();
    } else if (remainderMode === "merge" && groups.length > 1) {
      const prev = groups[groups.length - 2];
      // Merging past the template library's max count would drop images at
      // render time — keep the remainder as its own page instead.
      if (prev.length + last.length <= MAX_TEMPLATE_COUNT) {
        groups.pop();
        groups[groups.length - 1] = prev.concat(last);
      }
    }
  }
  return groups;
}
