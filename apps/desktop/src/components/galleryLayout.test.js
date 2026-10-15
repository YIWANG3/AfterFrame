import { describe, expect, it } from "vitest";
import {
  CAPTION_HEIGHT, GAP, VIEW_PADDING,
  buildGalleryGridLayout, buildGridLayout, buildJustifiedGalleryLayout, buildTileLayout, buildWaterfallLayout,
} from "./galleryLayout";

const photo = (id, width, height, shape) => ({ asset_id: id, image_metadata: { width, height }, display_shape: shape });
const landscape = (id) => photo(id, 4000, 3000);
const portrait = (id) => photo(id, 3000, 4000);

describe("buildGridLayout", () => {
  it("is null without a width", () => {
    expect(buildGridLayout([landscape("a")], 0, 200, 12, 4 / 3, 42, 8)).toBeNull();
  });

  it("fits as many columns as the thumb size allows and stretches the cells to the width", () => {
    const items = [landscape("a"), landscape("b"), landscape("c")];
    const layout = buildGridLayout(items, 516, 200, 12, 4 / 3, 42, 8);
    // 516 - 2*8 = 500 wide: two 200px columns + a 12px gap fit, three don't.
    expect(layout.positions.map((p) => p.left)).toEqual([0, 256, 0]);
    expect(layout.positions[0].width).toBe(244);
    expect(layout.positions[0].imgHeight).toBe(183);
    expect(layout.positions[2].top).toBe(183 + 42 + 12);
    expect(layout.totalHeight).toBe(2 * (183 + 42) + 12);
  });

  it("never goes below one column", () => {
    const layout = buildGridLayout([landscape("a")], 100, 200, 12, 4 / 3, 42, 8);
    expect(layout.positions).toHaveLength(1);
    expect(layout.positions[0].width).toBe(200);
  });

  it("grid cards carry a caption, tiles do not", () => {
    const items = [landscape("a")];
    expect(buildGalleryGridLayout(items, 400, 200).positions[0].captionHeight).toBe(CAPTION_HEIGHT);
    expect(buildTileLayout(items, 400, 200).positions[0].captionHeight).toBe(0);
  });
});

describe("buildWaterfallLayout", () => {
  it("sends each photo to the shortest column at its own aspect", () => {
    const items = [portrait("tall"), landscape("wide"), landscape("next")];
    const layout = buildWaterfallLayout(items, 416 + VIEW_PADDING * 2, 200);
    // Two 202px columns. The portrait makes column 0 tall, so the third
    // photo lands under the landscape in column 1.
    const [tall, wide, next] = layout.positions;
    expect(tall.left).toBe(0);
    expect(wide.left).toBe(202 + GAP);
    expect(next.left).toBe(wide.left);
    expect(next.top).toBe(wide.imgHeight + CAPTION_HEIGHT + GAP);
    expect(tall.imgHeight).toBeCloseTo(202 * 4 / 3);
    expect(layout.totalHeight).toBe(Math.max(tall.imgHeight + CAPTION_HEIGHT, next.top + next.imgHeight + CAPTION_HEIGHT));
  });

  it("turns a photo its display shape says is upright", () => {
    const layout = buildWaterfallLayout([photo("a", 4000, 3000, "portrait")], 300, 200);
    expect(layout.positions[0].imgHeight).toBeCloseTo(284 * 4 / 3);
  });
});

describe("buildJustifiedGalleryLayout", () => {
  it("is null without a width or without items", () => {
    expect(buildJustifiedGalleryLayout([landscape("a")], 0, 200)).toBeNull();
    expect(buildJustifiedGalleryLayout([], 800, 200)).toBeNull();
  });

  it("lays rows out with caption room, and reports each row's top and bottom", () => {
    const items = [landscape("a"), landscape("b"), portrait("c"), landscape("d"), landscape("e"), landscape("f")];
    const layout = buildJustifiedGalleryLayout(items, 700, 200);
    expect(layout.positions).toHaveLength(items.length);
    expect(layout.rowTops.length).toBe(layout.rowBottoms.length);
    expect(layout.rowTops.length).toBeGreaterThan(1);
    for (let i = 0; i < layout.rowTops.length; i += 1) {
      expect(layout.rowBottoms[i]).toBeGreaterThan(layout.rowTops[i]);
      if (i > 0) expect(layout.rowTops[i]).toBeGreaterThanOrEqual(layout.rowBottoms[i - 1]);
    }
    expect(layout.containerHeight).toBeGreaterThanOrEqual(layout.rowBottoms.at(-1));
  });
});
