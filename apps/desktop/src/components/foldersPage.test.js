import { describe, expect, it } from "vitest";
import {
  FOLDER_PAGE_SORTS,
  coverLayout,
  folderFilterCount,
  formatMonthRange,
  formatRelativeTime,
  parseStamp,
  selectRange,
  statusCounts,
  visibleFolderCards,
} from "./foldersPage";

// 2026-10-15 noon UTC.
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const folder = (name, extra = {}) => ({
  collection_id: `id-${name}`,
  kind: "manual",
  name,
  sort_order: 0,
  item_count: 0,
  created_at: "2026-01-01 00:00:00",
  last_added_at: null,
  captured_from: null,
  captured_to: null,
  cover_preview_paths: [],
  ...extra,
});

const names = (rows) => rows.map((r) => r.name);

const LIBRARY = [
  folder("Tokyo", { item_count: 128, sort_order: 2, created_at: "2025-03-02 00:00:00", last_added_at: "2026-10-12 08:00:00", captured_from: "2025-03-02T10:00:00", captured_to: "2025-06-30T18:00:00" }),
  folder("GFX tests", { item_count: 64, sort_order: 0, created_at: "2025-09-14 00:00:00", last_added_at: "2026-10-14 08:00:00", captured_from: "2025-09-01T10:00:00", captured_to: "2025-09-20T18:00:00" }),
  folder("Cats", { item_count: 154, sort_order: 1, created_at: "2022-10-10 00:00:00", last_added_at: "2026-08-01 08:00:00", captured_from: "2022-10-10T10:00:00", captured_to: "2025-12-24T18:00:00" }),
  folder("Empty one", { sort_order: 3, created_at: "2026-10-01 00:00:00" }),
  { collection_id: "smart", kind: "smart", name: "Five stars", item_count: 9, sort_order: 4 },
];

describe("visibleFolderCards", () => {
  it("shows folders only, newest addition first by default, never-added ones last", () => {
    expect(names(visibleFolderCards(LIBRARY, { now: NOW }))).toEqual(["GFX tests", "Tokyo", "Cats", "Empty one"]);
  });

  it("offers the sidebar's sorts plus capture date", () => {
    expect(FOLDER_PAGE_SORTS).toEqual(["lastAdded", "custom", "name", "newest", "largest", "captured"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "custom", now: NOW }))).toEqual(["GFX tests", "Cats", "Tokyo", "Empty one"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "name", now: NOW }))).toEqual(["Cats", "Empty one", "GFX tests", "Tokyo"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "newest", now: NOW }))).toEqual(["Empty one", "GFX tests", "Tokyo", "Cats"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "largest", now: NOW }))).toEqual(["Cats", "Tokyo", "GFX tests", "Empty one"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "captured", now: NOW }))).toEqual(["Cats", "GFX tests", "Tokyo", "Empty one"]);
    expect(names(visibleFolderCards(LIBRARY, { sort: "bogus", now: NOW }))).toEqual(names(visibleFolderCards(LIBRARY, { now: NOW })));
  });

  it("searches names case-insensitively", () => {
    expect(names(visibleFolderCards(LIBRARY, { query: "  gfx ", now: NOW }))).toEqual(["GFX tests"]);
    expect(visibleFolderCards(LIBRARY, { query: "zzz", now: NOW })).toEqual([]);
  });

  it("filters by status: empty, or changed in the last 30 days", () => {
    expect(names(visibleFolderCards(LIBRARY, { filters: { status: "empty" }, now: NOW }))).toEqual(["Empty one"]);
    expect(names(visibleFolderCards(LIBRARY, { filters: { status: "recent" }, now: NOW }))).toEqual(["GFX tests", "Tokyo"]);
    expect(statusCounts(LIBRARY, { filters: {}, now: NOW })).toEqual({ all: 4, empty: 1, recent: 2 });
    // The counts respect the search and the other facets.
    expect(statusCounts(LIBRARY, { query: "s", filters: { status: "empty" }, now: NOW })).toEqual({ all: 2, empty: 0, recent: 1 });
  });

  it("filters by photo count and by when a photo last joined", () => {
    expect(names(visibleFolderCards(LIBRARY, { filters: { count_min: 100 }, now: NOW }))).toEqual(["Tokyo", "Cats"]);
    expect(names(visibleFolderCards(LIBRARY, { filters: { count_max: 64 }, now: NOW }))).toEqual(["GFX tests", "Empty one"]);
    expect(names(visibleFolderCards(LIBRARY, { filters: { added_within_days: 2 }, now: NOW }))).toEqual(["GFX tests"]);
  });

  it("filters by capture dates: the folder's span must overlap the range", () => {
    expect(names(visibleFolderCards(LIBRARY, { filters: { date_from: "2025-06-01", date_to: "2025-06-30" }, now: NOW }))).toEqual(["Tokyo", "Cats"]);
    expect(names(visibleFolderCards(LIBRARY, { filters: { date_from: "2025-07-01" }, now: NOW }))).toEqual(["GFX tests", "Cats"]);
    expect(names(visibleFolderCards(LIBRARY, { filters: { date_to: "2023-01-01" }, now: NOW }))).toEqual(["Cats"]);
    // "Last N days" of capture time: only Cats shot something within a year.
    expect(names(visibleFolderCards(LIBRARY, { filters: { date_within_days: 365 }, now: NOW }))).toEqual(["Cats"]);
    // A folder without capture times never matches a date facet.
    expect(names(visibleFolderCards(LIBRARY, { filters: { date_from: "2000-01-01" }, now: NOW }))).not.toContain("Empty one");
  });

  it("counts active facets like the filter bar's badge", () => {
    expect(folderFilterCount({})).toBe(0);
    expect(folderFilterCount({ status: "empty", count_min: 1, count_max: 5, date_within_days: 7, added_within_days: 30 })).toBe(4);
  });
});

describe("selectRange", () => {
  const ids = ["a", "b", "c", "d"];
  it("spans the anchor and the target either way round", () => {
    expect(selectRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(selectRange(ids, "c", "c")).toEqual(["c"]);
  });
  it("falls back to the target without an anchor in the list", () => {
    expect(selectRange(ids, null, "c")).toEqual(["c"]);
    expect(selectRange(ids, "gone", "c")).toEqual(["c"]);
    expect(selectRange(ids, "a", "gone")).toEqual([]);
  });
});

describe("labels", () => {
  it("lays the cover mosaic out by preview count", () => {
    expect([0, 1, 2, 3, 4, 9].map(coverLayout)).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("reads SQLite's zoneless UTC stamps and EXIF's colon dates", () => {
    expect(parseStamp("2026-10-15 05:00:00", { zoneless: "utc" }).toISOString()).toBe("2026-10-15T05:00:00.000Z");
    expect(parseStamp("2025:03:02 10:00:00").getMonth()).toBe(2);
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("not a date")).toBeNull();
  });

  it("formats the capture span as months", () => {
    expect(formatMonthRange("2025-03-02T10:00:00", "2025-06-30T18:00:00", "en-US")).toBe("Mar – Jun 2025");
    expect(formatMonthRange("2024-11-20T10:00:00", "2025-08-01T18:00:00", "en-US")).toBe("Nov 2024 – Aug 2025");
    expect(formatMonthRange("2025-06-01T10:00:00", "2025-06-30T18:00:00", "en-US")).toBe("Jun 2025");
    expect(formatMonthRange("2025-03-02T10:00:00", "2025-06-30T18:00:00", "zh-CN")).toBe("2025年3月–6月");
    expect(formatMonthRange("2024-11-20T10:00:00", "2025-08-01T18:00:00", "zh-CN")).toBe("2024年11月–2025年8月");
    expect(formatMonthRange(null, null, "en-US")).toBeNull();
  });

  it("says how long ago a photo last joined", () => {
    const at = (iso) => formatRelativeTime(iso, { now: NOW, locale: "en-US" });
    expect(at("2026-10-15 11:59:40")).toBe("now");
    expect(at("2026-10-15 11:30:00")).toBe("30 minutes ago");
    expect(at("2026-10-15 05:00:00")).toBe("7 hours ago");
    expect(at("2026-10-14 12:00:00")).toBe("yesterday");
    expect(at("2026-10-01 12:00:00")).toBe("2 weeks ago");
    expect(at("2026-06-15 12:00:00")).toBe("4 months ago");
    expect(at("2024-06-15 12:00:00")).toBe("2 years ago");
    expect(at(null)).toBeNull();
  });
});
