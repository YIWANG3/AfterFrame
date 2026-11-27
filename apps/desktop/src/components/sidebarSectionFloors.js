// The sidebar's three sections (smart collections, collections, folders on
// disk) share what the entries above them leave. Each is as tall as its rows
// up to a share of the sidebar, and when together they don't fit each gives
// way in proportion to its rows. Left at that, a short section next to a long
// one gave way almost entirely: three smart collections beside forty
// collections kept only their heading.
//
// So an open section keeps a floor: its first rows (all of them when it has
// fewer), and never more than an even split of the space the sections share,
// so in a short window they all still fit. Past its floor a section gives way
// as before and scrolls inside. The sidebar itself never scrolls.

import { useLayoutEffect } from "react";

export const FLOOR_ROWS = 3;

// The sections, each by its root (a child of the sidebar's <nav>) and the
// list that scrolls inside it.
const SECTIONS = [
  ["[data-smart-collections]", "[data-smart-collections-list]"],
  ["[data-sidebar-folders]", "[data-testid='sidebar-folder-scroll']"],
  ["[data-disk-folders]", "[data-disk-folders-list]"],
];

// Each open section's floor: what it wants (its heading and first rows),
// held to an even split of the space the open sections share. A section
// that wants less than its split leaves the rest to the others.
export function sectionFloors(shared, wanted) {
  const floors = wanted.map(() => 0);
  let left = Math.max(0, shared);
  const order = wanted.map((height, index) => index).sort((a, b) => wanted[a] - wanted[b]);
  order.forEach((index, done) => {
    const floor = Math.max(0, Math.min(wanted[index], left / (order.length - done)));
    floors[index] = Math.floor(floor);
    left -= floor;
  });
  return floors;
}

// The height from the top of the section to the bottom of its `rows`th row,
// with the list's bottom padding: the heading and first rows, whatever is
// scrolled.
function wantedHeight(root, list, rows) {
  const listBox = list.getBoundingClientRect();
  const head = listBox.top - root.getBoundingClientRect().top;
  const items = Array.from(list.children);
  const last = items[Math.min(rows, items.length) - 1];
  const padding = parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const content = last ? last.getBoundingClientRect().bottom - listBox.top + list.scrollTop + padding : list.scrollHeight;
  return head + Math.min(content, list.scrollHeight);
}

export function applySectionFloors(nav, rows = FLOOR_ROWS) {
  if (!nav) return;
  const sections = SECTIONS
    .map(([section, list]) => {
      const root = nav.querySelector(`:scope > ${section}`);
      return root && { root, list: root.querySelector(list) };
    })
    .filter(Boolean);
  const open = sections.filter(({ root, list }) => root.dataset.open === "true" && list);
  for (const { root } of sections) {
    if (!open.some((section) => section.root === root)) root.style.minHeight = "";
  }
  if (!open.length) return;

  const children = Array.from(nav.children);
  const gap = parseFloat(getComputedStyle(nav).rowGap) || 0;
  const taken = children
    .filter((child) => !open.some((section) => section.root === child))
    .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
  const shared = nav.clientHeight - taken - gap * Math.max(0, children.length - 1);
  const floors = sectionFloors(shared, open.map(({ root, list }) => wantedHeight(root, list, rows)));
  open.forEach(({ root }, index) => {
    const next = `${floors[index]}px`;
    if (root.style.minHeight !== next) root.style.minHeight = next;
  });
}

// Keeps the floors current: after every render of the sidebar, when a
// section folds or unfolds, and when the window, a section or its list
// changes size (rows coming or going, a search narrowing them, the interface
// scale).
//
// A fold has to be watched for itself. Smart collections and the folders on
// disk keep their fold in their own state, so folding one doesn't render the
// sidebar, and the floor holds the folded section at its old height: no size
// changes for the ResizeObserver to see, and a blank stays under the heading.
export function useSectionFloors(navRef) {
  useLayoutEffect(() => {
    applySectionFloors(navRef.current);
  });
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applySectionFloors(nav));
    };
    // Setting a floor resizes a section and so calls this again, but the
    // second pass finds nothing to change and it settles.
    const observer = new ResizeObserver(schedule);
    // The nav, each of its children, and each section's list: a list is
    // sized by its rows, so it changes size when they do even while a floor
    // holds its section still.
    const observeAll = () => {
      observer.disconnect();
      observer.observe(nav);
      for (const child of nav.children) observer.observe(child);
      for (const [section, list] of SECTIONS) {
        const element = nav.querySelector(`:scope > ${section} ${list}`);
        if (element) observer.observe(element);
      }
    };
    observeAll();
    // A section hidden or shown again comes and goes as a child of the nav;
    // one folded or unfolded flips its data-open, and its list comes or goes.
    // Both are put right, before the next paint.
    const refresh = () => {
      observeAll();
      applySectionFloors(nav);
    };
    const children = new MutationObserver(refresh);
    children.observe(nav, { childList: true });
    // Only the section roots carry data-open, so this sees folds and nothing else.
    const folds = new MutationObserver(refresh);
    folds.observe(nav, { subtree: true, attributes: true, attributeFilter: ["data-open"] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      children.disconnect();
      folds.disconnect();
    };
  }, [navRef]);
}
