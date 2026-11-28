import { describe, expect, it } from "vitest";
import { madeInCatalog } from "./madeInCatalog";

describe("madeInCatalog", () => {
  it("is true for a file in the catalog's derived folder only", () => {
    expect(madeInCatalog("/Users/me/main.afcatalog/derived/a_edit_1.jpg", "/Users/me/main.afcatalog")).toBe(true);
    expect(madeInCatalog("/Users/me/main.afcatalog/derived/a_edit_1.jpg", "/Users/me/main.afcatalog/")).toBe(true);
    expect(madeInCatalog("/Users/me/Photos/a.jpg", "/Users/me/main.afcatalog")).toBe(false);
    expect(madeInCatalog("/Users/me/main.afcatalog/previews/im/a.jpg", "/Users/me/main.afcatalog")).toBe(false);
    expect(madeInCatalog("/Users/me/main.afcatalog-derived/a.jpg", "/Users/me/main.afcatalog")).toBe(false);
    expect(madeInCatalog("/Users/me/other.afcatalog/derived/a.jpg", "/Users/me/main.afcatalog")).toBe(false);
    // The sidecar's path has the symlink resolved; the app's may not.
    expect(madeInCatalog("/private/var/folders/x/main.afcatalog/derived/a.jpg", "/var/folders/x/main.afcatalog")).toBe(true);
  });

  it("reads Windows paths, and is false without a path or a catalog", () => {
    expect(madeInCatalog("C:\\Users\\me\\main.afcatalog\\derived\\a.jpg", "C:\\Users\\me\\main.afcatalog")).toBe(true);
    expect(madeInCatalog(null, "/c.afcatalog")).toBe(false);
    expect(madeInCatalog("/c.afcatalog/derived/a.jpg", null)).toBe(false);
  });
});
