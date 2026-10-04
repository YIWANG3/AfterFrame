import { describe, expect, it } from "vitest";
import { needsOnDemandHd } from "./useOnDemandHdPreviews";

describe("on-demand HD previews", () => {
  const raw = { asset_id: "raw_1", asset_type: "raw", image_path: "/photos/IMG_0001.CR3" };

  it("are made for a RAW that has none", () => {
    expect(needsOnDemandHd(raw)).toBe(true);
  });

  it("aren't made for images, RAWs that have one, or RAWs that are offline", () => {
    expect(needsOnDemandHd({ ...raw, asset_type: "image" })).toBe(false);
    expect(needsOnDemandHd({ ...raw, preview_hd_path: "/catalog/hd.jpg" })).toBe(false);
    expect(needsOnDemandHd({ ...raw, image_preview_hd_path: "/catalog/hd.jpg" })).toBe(false);
    expect(needsOnDemandHd({ ...raw, exists_on_disk: false })).toBe(false);
    expect(needsOnDemandHd(null)).toBe(false);
  });
});
