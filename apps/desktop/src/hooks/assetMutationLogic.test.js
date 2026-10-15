import { describe, expect, it } from "vitest";
import {
  FLAG_VALUES,
  descriptionFields,
  descriptionPatch,
  flagFields,
  flagPatch,
  normalizeDescription,
  patchList,
  patchRecord,
  ratingFields,
  ratingPatch,
  rollbackPatch,
  snapshotFields,
  uniqueIds,
} from "./assetMutationLogic";

const item = (asset_id, extra = {}) => ({ asset_id, stem: asset_id, ...extra });

describe("uniqueIds", () => {
  it("drops blanks and repeats, keeping the order given", () => {
    expect(uniqueIds(["b", null, "a", "b", "", undefined, "c"])).toEqual(["b", "a", "c"]);
    expect(uniqueIds(null)).toEqual([]);
  });
});

describe("snapshotFields", () => {
  it("records the targeted rows only, the first occurrence of an id winning", () => {
    const grid = [item("a", { app_rating: 3 }), item("b", { app_rating: 1 }), item("c")];
    const detail = item("a", { app_rating: 5 }); // a stale Inspector copy must not override the grid's
    const previous = snapshotFields([...grid, detail], new Set(["a", "c", "x"]), ratingFields);
    expect([...previous.entries()]).toEqual([["a", { app_rating: 3 }], ["c", { app_rating: null }]]);
  });

  it("includes an Inspector record that is not in the grid, and skips null records", () => {
    const previous = snapshotFields([null, item("z", { app_flag: 1 })], new Set(["z"]), flagFields);
    expect(previous.get("z")).toEqual({ app_flag: 1 });
  });
});

describe("patchRecord / patchList", () => {
  it("rewrites targeted records and returns untouched ones by identity", () => {
    const list = [item("a", { app_rating: 0 }), item("b", { app_rating: 0 })];
    const next = patchList(list, new Set(["a"]), ratingPatch(4));
    expect(next[0]).toEqual({ ...list[0], app_rating: 4 });
    expect(next[1]).toBe(list[1]);
    expect(patchRecord(null, new Set(["a"]), ratingPatch(4))).toBeNull();
  });

  it("rolls back from the snapshot, leaving records loaded since alone", () => {
    const previous = new Map([["a", { app_flag: FLAG_VALUES.pick }]]);
    const list = [item("a", { app_flag: FLAG_VALUES.reject }), item("b", { app_flag: FLAG_VALUES.reject })];
    const next = patchList(list, new Set(["a", "b"]), rollbackPatch(previous));
    expect(next[0].app_flag).toBe(FLAG_VALUES.pick);
    expect(next[1].app_flag).toBe(FLAG_VALUES.reject);
  });

  it("flags are the catalog's numbers", () => {
    expect(flagPatch(FLAG_VALUES.none)()).toEqual({ app_flag: 0 });
    expect(FLAG_VALUES).toEqual({ pick: 1, reject: -1, none: 0 });
  });
});

describe("description", () => {
  it("the user's text shows as theirs; an empty one leaves the field empty", () => {
    expect(descriptionPatch("A walk")(item("a"))).toEqual({ description: "A walk", description_source: "user" });
    expect(descriptionPatch("")(item("a", { ai_caption: "Sea" }))).toEqual({ description: null, description_source: "user" });
  });

  it("null hands the field back to the AI's caption, from either place it is kept", () => {
    expect(descriptionPatch(null)(item("a", { ai_caption: " Sea " }))).toEqual({ description: "Sea", description_source: "ai" });
    expect(descriptionPatch(null)(item("a", { annotation: { caption: "Hills" } }))).toEqual({ description: "Hills", description_source: "ai" });
    expect(descriptionPatch(null)(item("a"))).toEqual({ description: null, description_source: null });
  });

  it("snapshots both the text and whose it is", () => {
    expect(descriptionFields(item("a", { description: "x", description_source: "user" }))).toEqual({ description: "x", description_source: "user" });
    expect(descriptionFields(item("a"))).toEqual({ description: null, description_source: null });
  });

  it("normalizes what the catalog is sent", () => {
    expect(normalizeDescription(null)).toBeNull();
    expect(normalizeDescription("  hi  ")).toBe("hi");
    expect(normalizeDescription(undefined)).toBe("");
  });
});
