// The folder page (FoldersView): which folders show, in what order, and the
// labels on their cards — pure functions over the collection rows, which carry
// the page's columns from the sidecar (db/collections.py collection_stats):
// item_count, last_added_at, captured_from / captured_to, cover_preview_paths.

import { FOLDER_SORTS } from "./folderList";

// The sidebar's four plus the two only the page's columns make possible.
export const FOLDER_PAGE_SORTS = ["lastAdded", ...FOLDER_SORTS, "captured"];
export const DEFAULT_FOLDER_PAGE_SORT = "lastAdded";

// "Changed recently" means a photo joined within this many days.
export const RECENT_DAYS = 30;

// The page's facets, as filter keys (the same shape FilterBar's popovers take):
//   status            "empty" | "recent" (absent = all)
//   count_min/max     photos in the folder
//   date_from/to, date_within_days   the folder's capture span overlaps
//   added_within_days                a photo joined within N days
const FILTER_KEYS = ["status", "count_min", "count_max", "date_from", "date_to", "date_within_days", "added_within_days"];

export function folderFilterCount(filters) {
  const f = filters || {};
  let n = 0;
  if (f.status) n += 1;
  if (f.count_min != null || f.count_max != null) n += 1;
  if (f.date_from || f.date_to || f.date_within_days) n += 1;
  if (f.added_within_days) n += 1;
  return n;
}

export function hasFolderFilters(filters) {
  return FILTER_KEYS.some((key) => filters?.[key] != null && filters[key] !== "");
}

const DAY_MS = 24 * 60 * 60 * 1000;

// SQLite's CURRENT_TIMESTAMP has no zone and is UTC ("2026-10-15 05:00:00");
// capture times are the camera's local wall clock ("2025-03-02T10:00:00",
// sometimes EXIF's "2025:03:02 10:00:00"). Both become a Date; null if neither.
export function parseStamp(value, { zoneless = "local" } = {}) {
  if (!value) return null;
  let text = String(value).trim();
  const exif = /^(\d{4}):(\d{2}):(\d{2})[ T]/.exec(text);
  if (exif) text = `${exif[1]}-${exif[2]}-${exif[3]}${text.slice(10)}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    text = `${text.replace(" ", "T")}${zoneless === "utc" ? "Z" : ""}`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const lastAddedDate = (folder) => parseStamp(folder.last_added_at, { zoneless: "utc" });
const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function matchesFilters(folder, filters, now) {
  const f = filters || {};
  const count = folder.item_count || 0;
  if (f.status === "empty" && count !== 0) return false;
  if (f.status === "recent") {
    const added = lastAddedDate(folder);
    if (!added || now - added.getTime() > RECENT_DAYS * DAY_MS) return false;
  }
  if (f.count_min != null && count < Number(f.count_min)) return false;
  if (f.count_max != null && count > Number(f.count_max)) return false;
  if (f.added_within_days) {
    const added = lastAddedDate(folder);
    if (!added || now - added.getTime() > Number(f.added_within_days) * DAY_MS) return false;
  }
  if (f.date_within_days || f.date_from || f.date_to) {
    const from = parseStamp(folder.captured_from);
    const to = parseStamp(folder.captured_to);
    if (!from || !to) return false;
    // The folder's span and the asked range overlap (dates compared as days).
    const spanFrom = ymd(from);
    const spanTo = ymd(to);
    if (f.date_within_days) {
      if (spanTo < ymd(new Date(now - Number(f.date_within_days) * DAY_MS))) return false;
    } else {
      if (f.date_from && spanTo < String(f.date_from).slice(0, 10)) return false;
      if (f.date_to && spanFrom > String(f.date_to).slice(0, 10)) return false;
    }
  }
  return true;
}

export function visibleFolderCards(collections, { sort = DEFAULT_FOLDER_PAGE_SORT, query = "", filters = {}, locale, now = Date.now() } = {}) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byName = (a, b) => collator.compare(a.name || "", b.name || "");
  const needle = query.trim().toLocaleLowerCase(locale);
  const stamp = (value, zoneless) => parseStamp(value, { zoneless })?.getTime() || 0;
  const folders = (collections || []).filter((c) => c.kind === "manual"
    && (!needle || (c.name || "").toLocaleLowerCase(locale).includes(needle))
    && matchesFilters(c, filters, now));
  const compare = {
    custom: (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byName(a, b),
    name: byName,
    newest: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || byName(a, b),
    largest: (a, b) => (b.item_count || 0) - (a.item_count || 0) || byName(a, b),
    // Folders nothing was ever added to sink to the end, by name.
    lastAdded: (a, b) => stamp(b.last_added_at, "utc") - stamp(a.last_added_at, "utc") || byName(a, b),
    captured: (a, b) => stamp(b.captured_to, "local") - stamp(a.captured_to, "local") || byName(a, b),
  }[FOLDER_PAGE_SORTS.includes(sort) ? sort : DEFAULT_FOLDER_PAGE_SORT];
  return [...folders].sort(compare);
}

// Counts for the status facet's options: how many folders each would show,
// with the other facets and the search as they are.
export function statusCounts(collections, options) {
  const base = { ...(options.filters || {}) };
  delete base.status;
  const count = (status) => visibleFolderCards(collections, { ...options, filters: status ? { ...base, status } : base }).length;
  return { all: count(null), empty: count("empty"), recent: count("recent") };
}

// Shift-click: everything between the anchor and the target, in page order.
// Without an anchor (or one that left the list) the target alone.
export function selectRange(orderedIds, anchorId, targetId) {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (b < 0) return [];
  if (a < 0) return [targetId];
  return orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// The cover mosaic's shape by how many previews the folder has: 1 whole,
// 2 side by side, 3 one tall on the left + two stacked, 4+ a 2×2.
export function coverLayout(previewCount) {
  return Math.max(0, Math.min(4, previewCount || 0));
}

// The capture span as months: "Mar – Jun 2025", "Nov 2024 – Aug 2025", one
// month as "Jun 2025"; CJK joined by hand like formatDayRange, the year said
// once when both ends share it ("2025年3月–6月").
export function formatMonthRange(from, to, locale) {
  const start = parseStamp(from);
  const end = parseStamp(to) || start;
  if (!start) return null;
  const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short" });
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) return format.format(start);
  if (!/^(zh|ja|ko)\b/i.test(format.resolvedOptions().locale)) {
    return start.getFullYear() === end.getFullYear()
      ? `${new Intl.DateTimeFormat(locale, { month: "short" }).format(start)} – ${format.format(end)}`
      : `${format.format(start)} – ${format.format(end)}`;
  }
  if (start.getFullYear() !== end.getFullYear()) return `${format.format(start)}–${format.format(end)}`;
  const parts = format.formatToParts(end);
  const kept = parts.filter((part, index) => part.type !== "year"
    && !(part.type === "literal" && parts[index - 1]?.type === "year"));
  return `${format.format(start)}–${kept.map((part) => part.value).join("")}`;
}

// "3 days ago", "yesterday", "2 weeks ago" — for the last-added column.
export function formatRelativeTime(value, { now = Date.now(), locale, zoneless = "utc" } = {}) {
  const date = parseStamp(value, { zoneless });
  if (!date) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  if (abs < 35 * 86400) return rtf.format(Math.round(seconds / (7 * 86400)), "week");
  if (abs < 365 * 86400) return rtf.format(Math.round(seconds / (30 * 86400)), "month");
  return rtf.format(Math.round(seconds / (365 * 86400)), "year");
}
