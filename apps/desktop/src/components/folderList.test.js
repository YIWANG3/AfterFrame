import { describe, expect, it } from "vitest";

import { canReorderFolders, visibleFolders } from "./folderList";

const folder = (name, extra = {}) => ({ collection_id: `col_${name}`, kind: "manual", name, ...extra });
const names = (list) => list.map((c) => c.name);

const FOLDERS = [
  folder("Trip 10", { sort_order: 2, created_at: "2026-09-01 10:00:00", item_count: 5 }),
  folder("trip 2", { sort_order: 0, created_at: "2026-10-01 09:00:00", item_count: 40 }),
  folder("Album", { sort_order: 1, created_at: "2026-08-15 12:00:00", item_count: 5 }),
  { collection_id: "col_smart", kind: "smart", name: "Trip smart", sort_order: -5 },
];

describe("sidebar folder list", () => {
  it("keeps the dragged order by default, smart collections aside", () => {
    expect(names(visibleFolders(FOLDERS))).toEqual(["trip 2", "Album", "Trip 10"]);
  });

  it("sorts by name the way people count: case-blind, 2 before 10", () => {
    expect(names(visibleFolders(FOLDERS, { sort: "name" }))).toEqual(["Album", "trip 2", "Trip 10"]);
  });

  it("puts the newest first", () => {
    expect(names(visibleFolders(FOLDERS, { sort: "newest" }))).toEqual(["trip 2", "Trip 10", "Album"]);
  });

  it("puts the fullest first, ties by name", () => {
    expect(names(visibleFolders(FOLDERS, { sort: "largest" }))).toEqual(["trip 2", "Album", "Trip 10"]);
  });

  it("searches names case-blind, within the chosen order", () => {
    expect(names(visibleFolders(FOLDERS, { query: "  TRIP " }))).toEqual(["trip 2", "Trip 10"]);
    expect(names(visibleFolders(FOLDERS, { query: "trip", sort: "largest" }))).toEqual(["trip 2", "Trip 10"]);
    expect(visibleFolders(FOLDERS, { query: "nothing" })).toEqual([]);
  });

  it("matches Chinese names", () => {
    const list = [folder("京都 2025"), folder("大阪"), folder("京都夜景")];
    expect(names(visibleFolders(list, { query: "京都", sort: "name", locale: "zh-CN" }))).toEqual(["京都 2025", "京都夜景"]);
  });

  it("falls back to the dragged order for an unknown sort", () => {
    expect(names(visibleFolders(FOLDERS, { sort: "bogus" }))).toEqual(["trip 2", "Album", "Trip 10"]);
  });

  it("only allows dragging to reorder in the dragged order with no search", () => {
    expect(canReorderFolders({})).toBe(true);
    expect(canReorderFolders({ sort: "name" })).toBe(false);
    expect(canReorderFolders({ query: "trip" })).toBe(false);
    expect(canReorderFolders({ query: "   " })).toBe(true);
  });
});
