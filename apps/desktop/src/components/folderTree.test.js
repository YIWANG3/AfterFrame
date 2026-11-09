import { describe, expect, it } from "vitest";

import {
  ancestorIds,
  canDropInto,
  descendantIds,
  flattenForPicker,
  folderChildren,
  parentIdOf,
  parentPathOf,
  pathOf,
  siblingIds,
  visibleTreeRows,
} from "./folderTree";

const folder = (id, name, parent = null, extra = {}) => ({ collection_id: id, kind: "manual", name, parent_collection_id: parent, sort_order: 0, ...extra });
// Trips (Japan (Kyoto, Osaka), Europe), Other; a smart collection; an orphan.
const TREE = [
  folder("trips", "Trips", null, { sort_order: 1, item_count: 1, subtree_count: 6 }),
  folder("japan", "Japan", "trips", { sort_order: 0, item_count: 1 }),
  folder("kyoto", "Kyoto", "japan", { sort_order: 1, item_count: 2 }),
  folder("osaka", "Osaka", "japan", { sort_order: 0, item_count: 9 }),
  folder("europe", "Europe", "trips", { sort_order: 1, item_count: 1 }),
  folder("other", "Other", null, { sort_order: 0, item_count: 1 }),
  folder("lost", "Lost", "gone", { sort_order: 2 }),
  { collection_id: "smart", kind: "smart", name: "Stars", parent_collection_id: null, sort_order: -1 },
];
const names = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.folder.name}`);

describe("folder tree", () => {
  it("groups folders under their parent; a missing parent means the top level", () => {
    const children = folderChildren(TREE);
    expect(children.get(null).map((c) => c.name).sort()).toEqual(["Lost", "Other", "Trips"]);
    expect(children.get("japan").map((c) => c.name)).toEqual(["Kyoto", "Osaka"]);
    expect(children.has("smart")).toBe(false);
  });

  it("walks ancestors, descendants and paths", () => {
    expect(ancestorIds(TREE, "kyoto")).toEqual(["japan", "trips"]);
    expect(descendantIds(TREE, "trips").sort()).toEqual(["europe", "japan", "kyoto", "osaka"]);
    expect(descendantIds(TREE, "kyoto")).toEqual([]);
    expect(pathOf(TREE, "kyoto")).toBe("Trips / Japan / Kyoto");
    expect(parentPathOf(TREE, "kyoto")).toBe("Trips / Japan");
    expect(parentPathOf(TREE, "trips")).toBe("");
    expect(pathOf(TREE, "lost")).toBe("Lost");
    expect(parentIdOf(TREE, "lost")).toBe(null);
    expect(parentIdOf(TREE, "kyoto")).toBe("japan");
  });

  it("refuses a drop into itself or its own subtree, allows the top level", () => {
    expect(canDropInto(TREE, "trips", "kyoto")).toBe(false);
    expect(canDropInto(TREE, "trips", "trips")).toBe(false);
    expect(canDropInto(TREE, "kyoto", "trips")).toBe(true);
    expect(canDropInto(TREE, "kyoto", null)).toBe(true);
    expect(canDropInto(TREE, "kyoto", "smart")).toBe(false);
    expect(canDropInto(TREE, "kyoto", "missing")).toBe(false);
  });

  it("shows the top level only until a folder is expanded", () => {
    expect(names(visibleTreeRows(TREE, { expanded: new Set() }))).toEqual(["Other", "Trips", "Lost"]);
    const rows = visibleTreeRows(TREE, { expanded: new Set(["trips", "japan"]) });
    expect(names(rows)).toEqual(["Other", "Trips", "  Japan", "    Osaka", "    Kyoto", "  Europe", "Lost"]);
    expect(rows.find((r) => r.folder.name === "Trips")).toMatchObject({ hasChildren: true, expanded: true });
    expect(rows.find((r) => r.folder.name === "Kyoto")).toMatchObject({ hasChildren: false, expanded: false });
    // An expanded id without children is just a leaf.
    expect(names(visibleTreeRows(TREE, { expanded: ["kyoto"] }))).toEqual(["Other", "Trips", "Lost"]);
  });

  it("sorts each level on its own", () => {
    const rows = visibleTreeRows(TREE, { sort: "largest", expanded: new Set(["trips", "japan"]) });
    // Ties (Other and Trips both hold one photo) fall back to the name.
    expect(names(rows)).toEqual(["Other", "Trips", "  Europe", "  Japan", "    Osaka", "    Kyoto", "Lost"]);
    expect(names(visibleTreeRows(TREE, { sort: "name", expanded: new Set(["trips"]) }))).toEqual(["Lost", "Other", "Trips", "  Europe", "  Japan"]);
  });

  it("searches every depth as a flat list, each hit with its place", () => {
    const rows = visibleTreeRows(TREE, { query: "o", sort: "name" });
    expect(rows.map((r) => r.folder.name)).toEqual(["Europe", "Kyoto", "Lost", "Osaka", "Other"]);
    expect(rows.map((r) => r.pathLabel)).toEqual(["Trips", "Trips / Japan", "", "Trips / Japan", ""]);
    expect(rows.every((r) => r.depth === 0 && !r.hasChildren)).toBe(true);
  });

  it("flattens for a picker depth-first by name", () => {
    expect(flattenForPicker(TREE).map(({ folder: f, depth }) => `${depth}:${f.name}`))
      .toEqual(["0:Lost", "0:Other", "0:Trips", "1:Europe", "1:Japan", "2:Kyoto", "2:Osaka"]);
  });

  it("lists a folder's level in custom order", () => {
    expect(siblingIds(TREE, "kyoto")).toEqual(["osaka", "kyoto"]);
    expect(siblingIds(TREE, "trips")).toEqual(["other", "trips", "lost"]);
    expect(siblingIds(TREE, "missing")).toEqual([]);
  });
});
