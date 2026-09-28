import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOPE,
  activeFilterCount,
  browseScopeKey,
  chooseSelectionAfterReload,
  editScopeFromRules,
  facetScopeOf,
  filterItemsByQuery,
  hasRefinement,
  rulesDirty,
  rulesFromScope,
  scopeFromRules,
  scopeKeyOf,
  shouldResetScopeForReveal,
  sortOutsideFolder,
} from "./workspaceLogic";

const item = (asset_id, extra = {}) => ({ asset_id, stem: asset_id, ...extra });

describe("browseScopeKey", () => {
  it("normalizes absent collection/search/filters so equivalent scopes key the same", () => {
    const a = browseScopeKey({ status: "all", sort: "name-asc" });
    const b = browseScopeKey({ status: "all", collectionId: null, search: "", sort: "name-asc", filters: {} });
    expect(a).toBe(b);
    expect(browseScopeKey({ status: "all", sort: "name-asc", search: "x" })).not.toBe(a);
  });
});

describe("filterItemsByQuery", () => {
  const items = [
    item("a", { image_path: "/photos/IMG_0001.jpg" }),
    item("b", { annotation: { caption: "A golden sunset over the bay", tags: [], detected_text: null } }),
    item("c", { annotation: { caption: "", tags: ["街拍", "夜景"], detected_text: null } }),
    item("d", { annotation: { caption: "", tags: [], detected_text: "EXIT 24" } }),
    item("e", { image_metadata: { lens_model: "RF 24-70mm F2.8" } }),
  ];

  it("returns the same array for an empty query", () => {
    expect(filterItemsByQuery(items, "")).toBe(items);
    expect(filterItemsByQuery(items, "   ")).toBe(items);
  });

  it("matches everything the sidecar search matches: caption, tags, OCR text, lens", () => {
    // These four were the regression: the sidecar returned them, the client hid them.
    expect(filterItemsByQuery(items, "sunset").map((i) => i.asset_id)).toEqual(["b"]);
    expect(filterItemsByQuery(items, "夜景").map((i) => i.asset_id)).toEqual(["c"]);
    expect(filterItemsByQuery(items, "exit").map((i) => i.asset_id)).toEqual(["d"]);
    expect(filterItemsByQuery(items, "24-70").map((i) => i.asset_id)).toEqual(["e"]);
  });

  it("is case-insensitive on filename/path and tolerates missing fields", () => {
    expect(filterItemsByQuery(items, "img_0001").map((i) => i.asset_id)).toEqual(["a"]);
    expect(filterItemsByQuery([item("z")], "anything")).toEqual([]);
  });
});

describe("chooseSelectionAfterReload", () => {
  const payload = [item("p1"), item("p2")];

  it("keeps a selection that is still on the page", () => {
    expect(chooseSelectionAfterReload({ payload, activeSelectedId: "p2", relatedPinned: false, preserveView: false })).toBe("p2");
  });

  it("keeps an inspector-pinned version even when it left the page", () => {
    expect(chooseSelectionAfterReload({ payload, activeSelectedId: "v9", relatedPinned: true, preserveView: false })).toBe("v9");
  });

  it("falls back to the first tile for a user-driven reload, but never for a background refresh", () => {
    expect(chooseSelectionAfterReload({ payload, activeSelectedId: "gone", relatedPinned: false, preserveView: false })).toBe("p1");
    expect(chooseSelectionAfterReload({ payload, activeSelectedId: "gone", relatedPinned: false, preserveView: true })).toBe(null);
  });

  it("yields null for an empty page and ignores a stale pin with no selection", () => {
    expect(chooseSelectionAfterReload({ payload: [], activeSelectedId: null, relatedPinned: true, preserveView: false })).toBe(null);
  });
});

describe("shouldResetScopeForReveal", () => {
  const items = [item("x", { annotation: { caption: "seagull", tags: [] } })];

  it("resets when the asset isn't in the current scope at all", () => {
    expect(shouldResetScopeForReveal({ locationIndex: null, query: "", items, filteredItems: items, assetId: "x" })).toBe(true);
  });

  it("resets when the asset is on the server page but the local projection hides it", () => {
    const filtered = filterItemsByQuery(items, "IMG_9");   // filename-only query, caption-only asset
    expect(shouldResetScopeForReveal({ locationIndex: 3, query: "IMG_9", items, filteredItems: filtered, assetId: "x" })).toBe(true);
  });

  it("does not reset when the asset is located and visible", () => {
    expect(shouldResetScopeForReveal({ locationIndex: 3, query: "sea", items, filteredItems: items, assetId: "x" })).toBe(false);
    expect(shouldResetScopeForReveal({ locationIndex: 3, query: "", items, filteredItems: items, assetId: "x" })).toBe(false);
  });
});

describe("scopeKeyOf", () => {
  it("keys the default scope like an explicit all/no-collection/empty browse", () => {
    expect(scopeKeyOf(DEFAULT_SCOPE)).toBe(browseScopeKey({ status: "all", collectionId: null, search: undefined, sort: "imported-desc", filters: {} }));
  });
  it("ignores query whitespace, so typing a space is not a new destination", () => {
    expect(scopeKeyOf({ ...DEFAULT_SCOPE, query: "  " })).toBe(scopeKeyOf(DEFAULT_SCOPE));
    expect(scopeKeyOf({ ...DEFAULT_SCOPE, query: "sunset" })).not.toBe(scopeKeyOf(DEFAULT_SCOPE));
  });
  it("changes on every field that changes what the grid shows", () => {
    const base = scopeKeyOf(DEFAULT_SCOPE);
    for (const patch of [{ status: "rated" }, { collectionId: "c1" }, { sort: "name-asc" }, { filters: { tag: "x" } }]) {
      expect(scopeKeyOf({ ...DEFAULT_SCOPE, ...patch }), JSON.stringify(patch)).not.toBe(base);
    }
  });
});

describe("two layers: where the user is, and the refinement inside it", () => {
  const scope = (patch) => ({ ...DEFAULT_SCOPE, ...patch });
  const urban = { version: 1, status: "all", search: "", filters: { tag: "urban" } };
  const collection = { collection_id: "col_s", name: "urban", rules: urban };

  it("opening a smart collection makes its rules the base and leaves the filter bar empty", () => {
    const opened = scopeFromRules(collection, "rating-desc");
    expect(opened).toMatchObject({ smartCollectionId: "col_s", base: urban, filters: {}, query: "", editingRules: false, sort: "rating-desc" });
    expect(hasRefinement(opened)).toBe(false);
    expect(scopeFromRules({ collection_id: "x", rules: null }, "rating-desc")).toBeNull();
  });

  it("the base is part of what the grid shows, so it is part of the browse key", () => {
    expect(scopeKeyOf(scope({ base: urban }))).not.toBe(scopeKeyOf(scope({})));
    expect(scopeKeyOf(scope({ base: urban, smartCollectionId: "a" }))).toBe(scopeKeyOf(scope({ base: urban, smartCollectionId: "b" })));
  });

  it("a plain view saves its status, trimmed search and non-empty filters; the viewport never", () => {
    expect(rulesFromScope(scope({ status: "rated", query: "  neon ", filters: { rating_min: 4, camera: "", tag: null } })))
      .toEqual({ status: "rated", search: "neon", filters: { rating_min: 4 } });
    const geo = { mode: "bounds", west: 0, south: 0, east: 1, north: 1 };
    expect(rulesFromScope(scope({ filters: { geo, tag: "night" } }))).toEqual({ status: "all", search: "", filters: { tag: "night" } });
    expect(rulesFromScope(scope({ filters: { geo } }))).toBeNull();
    expect(rulesFromScope(DEFAULT_SCOPE)).toBeNull();
  });

  it("a refined folder saves as membership plus the refinement; an unrefined one has nothing to save", () => {
    expect(rulesFromScope(scope({ collectionId: "col_f", filters: { rating_min: 5 } })))
      .toEqual({ status: "all", search: "", filters: { rating_min: 5, in_collection: "col_f" } });
    expect(rulesFromScope(scope({ collectionId: "col_f" }))).toBeNull();
  });

  it("a refinement inside a smart collection saves NESTED on its rules, never merged into them", () => {
    const refined = { ...scopeFromRules(collection, "imported-desc"), filters: { tag: "night" } };
    // Both layers name `tag`: a merge would keep one of them.
    expect(rulesFromScope(refined)).toEqual({ status: "all", search: "", filters: { tag: "night" }, base: urban });
    expect(rulesFromScope(scopeFromRules(collection, "imported-desc"))).toBeNull();
  });

  it("editing shows the collection's own top layer in the bar and keeps a nested base underneath", () => {
    const nested = { collection_id: "col_n", rules: { status: "all", search: "fog", filters: { rating_min: 5 }, base: urban } };
    const editing = editScopeFromRules(nested, "imported-desc");
    expect(editing).toMatchObject({ editingRules: true, smartCollectionId: "col_n", query: "fog", filters: { rating_min: 5 }, base: urban });
    expect(rulesDirty(editing, nested.rules)).toBe(false);
    expect(rulesDirty({ ...editing, sort: "rating-desc" }, nested.rules)).toBe(false);
    expect(rulesDirty({ ...editing, filters: { rating_min: 4 } }, nested.rules)).toBe(true);
    // Saved from the editor: the edited top layer, the same base.
    expect(rulesFromScope({ ...editing, filters: { rating_min: 4 } })).toEqual({ status: "all", search: "fog", filters: { rating_min: 4 }, base: urban });
    // Viewing is never "dirty": a refinement there is not an edit.
    expect(rulesDirty({ ...scopeFromRules(collection, "imported-desc"), filters: { extension: "png" } }, urban)).toBe(false);
  });

  it("facet counts are taken inside the base, and a folder needs neither a status nor a base", () => {
    expect(facetScopeOf({ ...scopeFromRules(collection, "imported-desc"), filters: { extension: "png" } }))
      .toEqual({ collectionId: undefined, status: undefined, search: undefined, filters: { extension: "png" }, base: urban });
    expect(facetScopeOf(scope({ collectionId: "col_f", status: "rated" })))
      .toEqual({ collectionId: "col_f", status: undefined, search: undefined, filters: undefined, base: undefined });
  });

  it("a facet value may be a list: an empty one is no condition, and tick order is not a difference", () => {
    expect(hasRefinement(scope({ filters: { camera: [] } }))).toBe(false);
    expect(hasRefinement(scope({ filters: { tag_match: "all" } }))).toBe(false); // a modifier alone filters nothing
    expect(hasRefinement(scope({ filters: { camera: ["FC9113", "FC9184"] } }))).toBe(true);
    expect(rulesFromScope(scope({ filters: { camera: ["FC9113", "FC9184"], lens: [] } })))
      .toEqual({ status: "all", search: "", filters: { camera: ["FC9113", "FC9184"] } });
    // "All of these" only means something with several tags.
    expect(rulesFromScope(scope({ filters: { tag: "night", tag_match: "all" } })).filters).toEqual({ tag: "night" });
    expect(rulesFromScope(scope({ filters: { tag: ["night", "neon"], tag_match: "all" } })).filters)
      .toEqual({ tag: ["night", "neon"], tag_match: "all" });

    const drones = { collection_id: "col_d", rules: { status: "all", search: "", filters: { camera: ["FC9113", "FC9184"] } } };
    const editing = editScopeFromRules(drones, "imported-desc");
    expect(rulesDirty({ ...editing, filters: { camera: ["FC9184", "FC9113"] } }, drones.rules)).toBe(false);
    expect(rulesDirty({ ...editing, filters: { camera: ["FC9184"] } }, drones.rules)).toBe(true);
  });

  it("the folder-only sort does not leak out of a folder", () => {
    expect(sortOutsideFolder("added-desc")).toBe(DEFAULT_SCOPE.sort);
    expect(sortOutsideFolder("rating-desc")).toBe("rating-desc");
    expect(scopeFromRules(collection, "added-asc").sort).toBe(DEFAULT_SCOPE.sort);
  });
});

describe("smart collections v2: exclude, rating, any-of groups", () => {
  const scope = (extra) => ({ ...DEFAULT_SCOPE, ...extra });

  it("counts conditions, not the keys that only tune them", () => {
    expect(activeFilterCount({ camera: "X", exclude: "camera", tag: ["a", "b"], tag_match: "all" })).toBe(2);
    expect(activeFilterCount({ exclude: "camera", color_tolerance: "loose" })).toBe(0);
    expect(activeFilterCount({ rating_max: 0 })).toBe(1); // unrated is a condition, 0 is not "empty"
    expect(activeFilterCount({ any_of: [{ camera: "X" }, { tag: "night" }] })).toBe(1);
    expect(hasRefinement(scope({ filters: { exclude: "camera" } }))).toBe(false);
  });

  it("saves groups without their empty members", () => {
    const rules = rulesFromScope(scope({ filters: { any_of: [{ camera: "X", geo: { mode: "bounds" } }, { tag: [] }, {}] } }));
    expect(rules.filters).toEqual({ any_of: [{ camera: "X" }] });
    expect(rulesFromScope(scope({ filters: { any_of: [{}] } }))).toBeNull();
  });

  it("from a folder, a refinement that names folders keeps the folder underneath", () => {
    // "Five stars in Trip" still merges: nothing collides.
    expect(rulesFromScope(scope({ collectionId: "trip", filters: { rating_min: 5 } })).filters)
      .toEqual({ rating_min: 5, in_collection: "trip" });
    // "In Trip, not in Published": merging would turn it into "not in Trip".
    const notPublished = rulesFromScope(scope({ collectionId: "trip", filters: { in_collection: "pub", exclude: "in_collection" } }));
    expect(notPublished).toEqual({
      status: "all", search: "", filters: { in_collection: "pub", exclude: "in_collection" },
      base: { status: "all", search: "", filters: { in_collection: "trip" } },
    });
  });
});
