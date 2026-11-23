import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_HIDDEN_PREF, readSidebarHidden, setSidebarHidden, withHidden } from "./sidebarLayout";

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
});
