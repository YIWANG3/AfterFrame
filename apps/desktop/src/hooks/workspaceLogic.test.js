import { describe, expect, it } from "vitest";
import {
  browseScopeKey,
  chooseSelectionAfterReload,
  filterItemsByQuery,
  shouldResetScopeForReveal,
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
