import { describe, expect, it } from "vitest";
import { previewOnlyNotice } from "./useRawEditSource";

describe("editing a RAW from its preview", () => {
  const raw = { width: 1024, height: 576 };
  const failed = { path: "/catalog/previews-hd/luna.jpg", full: false, renderer: null, error: "LibRaw can't decode it" };

  it("is told, with both sizes, when the full-size render failed", () => {
    expect(previewOnlyNotice({ ...failed, width: 256, height: 144 }, raw)).toEqual({
      key: "overlay.rawPreviewOnly",
      values: { width: 256, height: 144, rawWidth: 1024, rawHeight: 576 },
    });
  });

  it("is told without sizes when either one is unknown", () => {
    const unknown = { key: "overlay.rawPreviewOnlyUnknownSize", values: {} };
    expect(previewOnlyNotice(failed, raw)).toEqual(unknown);
    expect(previewOnlyNotice({ ...failed, width: 256, height: 144 }, { width: 0, height: 0 })).toEqual(unknown);
  });

  it("isn't told when the editor has what it asked for", () => {
    // The HD preview is the RAW's full size, or a full-size render was made.
    expect(previewOnlyNotice({ path: failed.path, full: false }, raw)).toBeNull();
    expect(previewOnlyNotice({ path: "/cache/luna.jpg", full: true, renderer: "libraw" }, raw)).toBeNull();
    // Nothing to edit, or no answer.
    expect(previewOnlyNotice({ ...failed, path: null }, raw)).toBeNull();
    expect(previewOnlyNotice(null, raw)).toBeNull();
  });
});
