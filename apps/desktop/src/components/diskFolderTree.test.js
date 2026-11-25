import { describe, expect, it } from "vitest";
import { ancestorsOf, folderName, hasChildren, isSynced, isWithin, syncedBy, visibleRows } from "./diskFolderTree";

const folder = (path, parent, volume = "") => ({ path, name: folderName(path), parent, volume, direct: 1, total: 1, exists: true });

const TREE = [
  folder("/Users/me/2024", null),
  folder("/Users/me/2024/Kyoto", "/Users/me/2024"),
  folder("/Users/me/2024/Tokyo", "/Users/me/2024"),
  folder("/Users/me/2024/Tokyo/Day 2", "/Users/me/2024/Tokyo"),
];

describe("disk folders", () => {
  it("names a folder by its last part, either separator", () => {
    expect(folderName("/Users/me/2024/Tokyo")).toBe("Tokyo");
    expect(folderName("D:\\Shoots\\Tokyo")).toBe("Tokyo");
    expect(folderName("/Users/me/2024/")).toBe("2024");
  });

  it("tells a folder inside another from one whose name merely starts the same", () => {
    expect(isWithin("/a/2024/Tokyo", "/a/2024")).toBe(true);
    expect(isWithin("/a/2024", "/a/2024/")).toBe(true);
    expect(isWithin("/a/2024 copy", "/a/2024")).toBe(false);
    expect(isWithin("D:\\a\\b", "D:\\a")).toBe(true);
  });

  it("is synced when it or a folder above it is watched", () => {
    expect(isSynced("/Users/me/2024/Tokyo", ["/Users/me/2024"])).toBe(true);
    expect(isSynced("/Users/me/2024", ["/Users/me/2024/Tokyo"])).toBe(false);
    expect(isSynced("/x", [])).toBe(false);
  });

  it("names the watched folder that syncs it: itself, or the nearest one above", () => {
    expect(syncedBy("/Users/me/2024", ["/Users/me/2024"])).toBe("/Users/me/2024");
    expect(syncedBy("/Users/me/2024/Tokyo/Day 2", ["/Users/me", "/Users/me/2024"])).toBe("/Users/me/2024");
    expect(syncedBy("/Users/me/2024 copy", ["/Users/me/2024"])).toBeNull();
    expect(syncedBy("/x", undefined)).toBeNull();
  });

  it("knows a folder's ancestors and whether it has children", () => {
    expect(ancestorsOf(TREE, "/Users/me/2024/Tokyo/Day 2")).toEqual(["/Users/me/2024/Tokyo", "/Users/me/2024"]);
    expect(hasChildren(TREE, "/Users/me/2024/Tokyo")).toBe(true);
    expect(hasChildren(TREE, "/Users/me/2024/Kyoto")).toBe(false);
  });

  it("shows a folder's children only while it is expanded", () => {
    const collapsed = visibleRows(TREE, new Set());
    expect(collapsed.map((row) => row.folder.name)).toEqual(["2024"]);
    expect(collapsed[0]).toMatchObject({ depth: 0, expandable: true, expanded: false });

    const open = visibleRows(TREE, new Set(["/Users/me/2024", "/Users/me/2024/Tokyo"]));
    expect(open.map((row) => `${row.depth}:${row.folder.name}`)).toEqual(["0:2024", "1:Kyoto", "1:Tokyo", "2:Day 2"]);
    expect(open.find((row) => row.folder.name === "Kyoto").expandable).toBe(false);
  });

  it("sorts each level by photo count when asked", () => {
    const tree = [
      { ...folder("/a", null), total: 3 },
      { ...folder("/a/small", "/a"), total: 1 },
      { ...folder("/a/big", "/a"), total: 2 },
    ];
    expect(visibleRows(tree, new Set(["/a"]), { sort: "count" }).map((row) => row.folder.name)).toEqual(["a", "big", "small"]);
    expect(visibleRows(tree, new Set(["/a"])).map((row) => row.folder.name)).toEqual(["a", "small", "big"]);
  });

  it("a search shows the matching folders with the folders above them, opened", () => {
    const rows = visibleRows(TREE, new Set(), { query: "day" });
    expect(rows.map((row) => `${row.depth}:${row.folder.name}`)).toEqual(["0:2024", "1:Tokyo", "2:Day 2"]);
    expect(visibleRows(TREE, new Set(), { query: "nowhere" })).toEqual([]);
  });

  it("heads each volume's folders when there is another disk", () => {
    const rows = visibleRows([...TREE, folder("/Volumes/T7/Shoots", null, "T7")], new Set());
    expect(rows.map((row) => (row.kind === "volume" ? `[${row.volume || "local"}]` : row.folder.name))).toEqual(["[local]", "2024", "[T7]", "Shoots"]);
    expect(visibleRows(TREE, new Set()).some((row) => row.kind === "volume")).toBe(false);
  });
});
