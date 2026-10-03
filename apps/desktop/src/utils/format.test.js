import { describe, expect, it } from "vitest";

import {
  collapseRootPaths,
  determineImportMode,
  escapePathLabel,
  fileName,
  formatBytes,
  mergeRoots,
} from "./format";

describe("path helpers", () => {
  it("collapses duplicate and nested roots without collapsing sibling prefixes", () => {
    expect(collapseRootPaths([
      "/photos/2026/trip",
      "/photos",
      "/photoshop",
      "/photos/2025",
      "/photos",
    ])).toEqual(["/photos", "/photoshop"]);
  });

  it("normalizes Windows separators and merges roots", () => {
    expect(mergeRoots(["C:\\Photos"], ["C:\\Photos\\2026", "D:\\Exports"])).toEqual([
      "C:/Photos",
      "D:/Exports",
    ]);
    expect(fileName("C:\\Photos\\frame.jpg")).toBe("frame.jpg");
  });

  it("takes a folder's name with or without a trailing separator", () => {
    expect(fileName("C:\\Photos\\2026 Trip\\")).toBe("2026 Trip");
    expect(fileName("/Users/me/Pictures/")).toBe("Pictures");
    expect(fileName("C:\\Users\\me\\Pictures\\中文相册\\莫罗岩.jpg")).toBe("莫罗岩.jpg");
  });

  it("shortens long paths with their own separator", () => {
    expect(escapePathLabel("/Users/me/Pictures/2026/trip/a.jpg")).toBe(".../2026/trip/a.jpg");
    expect(escapePathLabel("C:\\Users\\me\\Pictures\\2026\\a.jpg")).toBe("...\\Pictures\\2026\\a.jpg");
    expect(escapePathLabel("/short/a.jpg")).toBe("/short/a.jpg");
    expect(escapePathLabel("")).toBe("Not linked");
  });
});

describe("import mode", () => {
  it("distinguishes source-only, processed-only and combined imports", () => {
    expect(determineImportMode({}, { rawDirs: ["/raw"] })).toBe("source_only");
    expect(determineImportMode({}, { imageDirs: ["/images"] })).toBe("processed_only");
    expect(determineImportMode({}, { rawDirs: ["/raw"], imageDirs: ["/images"] })).toBe("combined");
  });

  it("uses existing catalog contents to choose an incremental mode", () => {
    expect(determineImportMode({ image_assets: 2 }, { rawDirs: ["/raw"] })).toBe("source_with_media");
    expect(determineImportMode({ raw_assets: 2 }, { imageDirs: ["/images"] })).toBe("processed_with_sources");
  });
});

describe("formatBytes", () => {
  it("formats valid sizes and rejects empty or invalid values", () => {
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
});
