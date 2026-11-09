import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTargetFolderId, resolveTargetFolder, writeTargetFolderId } from "./targetFolder";

const folders = [
  { collection_id: "f1", kind: "manual", name: "Trip" },
  { collection_id: "s1", kind: "smart", name: "Five stars" },
];

describe("the target folder", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is remembered per catalog", () => {
    writeTargetFolderId("/a.afcatalog", "f1");
    writeTargetFolderId("/b.afcatalog", "f2");
    expect(readTargetFolderId("/a.afcatalog")).toBe("f1");
    expect(readTargetFolderId("/b.afcatalog")).toBe("f2");
    expect(readTargetFolderId("/c.afcatalog")).toBeNull();
    expect(readTargetFolderId(null)).toBeNull();
  });

  it("is forgotten when written null", () => {
    writeTargetFolderId("/a.afcatalog", "f1");
    writeTargetFolderId("/a.afcatalog", null);
    expect(readTargetFolderId("/a.afcatalog")).toBeNull();
  });

  it("only counts while it is still a folder", () => {
    expect(resolveTargetFolder(folders, "f1")?.name).toBe("Trip");
    expect(resolveTargetFolder(folders, "s1")).toBeNull();
    expect(resolveTargetFolder(folders, "gone")).toBeNull();
    expect(resolveTargetFolder(folders, null)).toBeNull();
    expect(resolveTargetFolder(null, "f1")).toBeNull();
  });
});
