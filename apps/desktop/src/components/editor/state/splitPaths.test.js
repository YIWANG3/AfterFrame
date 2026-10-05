import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api", () => ({ default: {} }));
const { resolveSplitOutputDir, splitPanelPaths } = await import("./useSplitExport");

describe("split output paths", () => {
  it("keep a Windows folder's backslashes", () => {
    expect(resolveSplitOutputDir("C:\\Photos\\pano.jpg", null, true)).toBe("C:\\Photos\\pano_split");
    expect(resolveSplitOutputDir("C:\\Photos\\pano.jpg", "D:\\Out", false)).toBe("D:\\Out");
    expect(splitPanelPaths("C:\\Photos\\pano.jpg", null, true, 2)).toEqual([
      "C:\\Photos\\pano_split\\pano_split_01.jpg",
      "C:\\Photos\\pano_split\\pano_split_02.jpg",
    ]);
  });

  it("keep POSIX folders as they were", () => {
    expect(resolveSplitOutputDir("/Users/me/pano.png", null, true)).toBe("/Users/me/pano_split");
    expect(splitPanelPaths("/Users/me/pano.png", "/tmp/out", false, 1)).toEqual(["/tmp/out/pano_split_01.png"]);
  });
});
