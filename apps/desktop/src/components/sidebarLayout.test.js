import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_HIDDEN_PREF, SIDEBAR_ORDER_PREF, arranged, defaultEntryOrder, moveSidebarEntry, moved, readSidebarHidden,
  readSidebarOrder, setSidebarHidden, sidebarOrder, withHidden,
} from "./sidebarLayout";

describe("sidebar layout", () => {
  beforeEach(() => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    vi.stubGlobal("window", { dispatchEvent: () => true });
    vi.stubGlobal("CustomEvent", class { constructor(type, init) { this.type = type; this.detail = init?.detail; } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hides and shows an entry, once", () => {
    expect(withHidden([], "tags", true)).toEqual(["tags"]);
    expect(withHidden(["tags"], "tags", true)).toEqual(["tags"]);
    expect(withHidden(["tags", "stats"], "tags", false)).toEqual(["stats"]);
  });

  it("never hides All Assets", () => {
    expect(withHidden([], "all", true)).toEqual([]);
  });

  it("remembers what is hidden and ignores what isn't a list of names", () => {
    setSidebarHidden("discover", true);
    setSidebarHidden("diskFolders", true);
    expect(readSidebarHidden()).toEqual(["discover", "diskFolders"]);
    localStorage.setItem(`afterframe.pref.${SIDEBAR_HIDDEN_PREF}`, JSON.stringify("tags"));
    expect(readSidebarHidden()).toEqual([]);
  });

  it("lists the entries in the sidebar's own order, the feature views after Look-alikes", () => {
    expect(defaultEntryOrder(["stickers"])).toEqual(["discover", "recent", "rated", "lookalikes", "stickers", "people", "tags", "stats"]);
    expect(sidebarOrder([]).sections).toEqual(["smartCollections", "collections", "diskFolders"]);
  });

  it("keeps the order the user left, and puts an entry added since after the one it follows", () => {
    const ids = ["a", "b", "c", "d"];
    expect(arranged(ids, [])).toEqual(ids);
    expect(arranged(ids, ["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"]);
    // "c" is new: it follows "b", wherever the user put "b".
    expect(arranged(ids, ["b", "d", "a"])).toEqual(["b", "c", "d", "a"]);
    // "a" is new and follows nothing: first.
    expect(arranged(ids, ["d", "c", "b"])).toEqual(["a", "d", "c", "b"]);
    // Names no longer known, and repeats, are dropped.
    expect(arranged(ids, ["gone", "c", "c", "a", "b", "d"])).toEqual(["c", "a", "b", "d"]);
  });

  it("moves an entry before or after another, and leaves anything else alone", () => {
    expect(moved(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(moved(["a", "b", "c"], "a", "b", "before")).toEqual(["a", "b", "c"]);
    expect(moved(["a", "b", "c"], "a", "a", "after")).toEqual(["a", "b", "c"]);
    expect(moved(["a", "b", "c"], "x", "a", "after")).toEqual(["a", "b", "c"]);
  });

  it("remembers a move, each group in its own place", () => {
    moveSidebarEntry("stats", "recent", "before", ["stickers"]);
    moveSidebarEntry("diskFolders", "smartCollections", "before", ["stickers"]);
    // An entry can't land among the sections, nor a section among the entries.
    moveSidebarEntry("tags", "collections", "after", ["stickers"]);
    expect(sidebarOrder(readSidebarOrder(), ["stickers"])).toEqual({
      entries: ["discover", "stats", "recent", "rated", "lookalikes", "stickers", "people", "tags"],
      sections: ["diskFolders", "smartCollections", "collections"],
    });
    localStorage.setItem(`afterframe.pref.${SIDEBAR_ORDER_PREF}`, JSON.stringify({ not: "a list" }));
    expect(readSidebarOrder()).toEqual([]);
  });
});
