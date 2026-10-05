import { describe, expect, it } from "vitest";

import {
  browseCount,
  collapseRootPaths,
  determineImportMode,
  escapePathLabel,
  fileName,
  formatBytes,
  formatDayRange,
  formatTimestamp,
  mergeRoots,
  navItems,
  pathSeparator,
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

  it("tells a Windows path's separator from a POSIX one", () => {
    expect(pathSeparator("C:\\Users\\me\\Pictures")).toBe("\\");
    expect(pathSeparator("\\\\nas\\photos")).toBe("\\");
    expect(pathSeparator("/Users/me/Pictures")).toBe("/");
    expect(pathSeparator("C:/Users/me")).toBe("/");
    expect(pathSeparator("")).toBe("/");
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

describe("All Assets count", () => {
  it("counts the RAW files and videos imported as photos, not only exports", () => {
    const summary = { image_assets: 39, raw_assets: 2604, browse_assets: 2669 };
    expect(browseCount(summary)).toBe(2669);
    expect(navItems(summary).find((item) => item.key === "all").count).toBe(2669);
    // An older sidecar reports exports only.
    expect(browseCount({ image_assets: 39 })).toBe(39);
    expect(browseCount(null)).toBe(0);
  });
});

describe("formatTimestamp", () => {
  const shown = (date) => date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  it("reads the catalog's own zoneless stamps as UTC", () => {
    // SQLite CURRENT_TIMESTAMP, as an import is stamped.
    expect(formatTimestamp("2026-10-05 03:37:05", { zoneless: "utc" })).toBe(shown(new Date(Date.UTC(2026, 9, 5, 3, 37, 5))));
    // A time that says its zone keeps it either way.
    expect(formatTimestamp("2026-10-05T03:37:05+00:00", { zoneless: "utc" })).toBe(shown(new Date(Date.UTC(2026, 9, 5, 3, 37, 5))));
    expect(formatTimestamp("2026-10-05T03:37:05+00:00")).toBe(shown(new Date(Date.UTC(2026, 9, 5, 3, 37, 5))));
  });

  it("shows a capture time as the camera's clock wrote it", () => {
    expect(formatTimestamp("2024-01-02T18:05:00")).toBe(shown(new Date(2024, 0, 2, 18, 5, 0)));
  });

  it("passes through what it can't read, and says Unknown for nothing", () => {
    expect(formatTimestamp("not a date", { zoneless: "utc" })).toBe("not a date");
    expect(formatTimestamp(null)).toBe("Unknown");
  });
});

describe("formatDayRange", () => {
  // Intl puts thin and no-break spaces around the en dash.
  const plain = (text) => text.replace(/[\u2009\u202f\u00a0]/g, " ");

  it("writes Chinese ranges the way they are said, never with a stray 日:", () => {
    expect(formatDayRange("2024-01-02", "2024-01-06", "zh-CN", 2026)).toBe("2024年1月2日–6日");
    expect(formatDayRange("2024-01-30", "2024-02-02", "zh-CN", 2026)).toBe("2024年1月30日–2月2日");
    expect(formatDayRange("2023-12-30", "2024-01-02", "zh-CN", 2026)).toBe("2023年12月30日–2024年1月2日");
    expect(formatDayRange("2024-01-02", "2024-01-02", "zh-CN", 2026)).toBe("2024年1月2日");
    expect(formatDayRange("2026-01-02", "2026-01-06", "zh-CN", 2026)).toBe("1月2日–6日");
  });

  it("uses the platform's range format for English", () => {
    expect(plain(formatDayRange("2024-01-02", "2024-01-06", "en", 2026))).toBe("Jan 2 – 6, 2024");
    expect(plain(formatDayRange("2024-01-30", "2024-02-02", "en", 2026))).toBe("Jan 30 – Feb 2, 2024");
    expect(plain(formatDayRange("2023-12-30", "2024-01-02", "en", 2026))).toBe("Dec 30, 2023 – Jan 2, 2024");
    expect(plain(formatDayRange("2026-01-02", "2026-01-06", "en", 2026))).toBe("Jan 2 – 6");
    expect(plain(formatDayRange("2024-01-02", "2024-01-02", "en", 2026))).toBe("Jan 2, 2024");
  });
});
