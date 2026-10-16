import { describe, expect, it } from "vitest";

import { blendedCellRect, getImageRect, getPixelAlignedStrokeRect, uncoveredStrips } from "./collageRender";

const cell = { x: 10, y: 20, w: 200, h: 100 };
const landscape = { naturalWidth: 400, naturalHeight: 100 }; // wider than the cell
const portrait = { naturalWidth: 100, naturalHeight: 400 };

describe("getImageRect", () => {
  it("cover-fits: the image touches two edges and overshoots the other two, centred", () => {
    const rect = getImageRect(landscape, cell, { x: 0, y: 0 }, 1);
    expect(rect).toEqual({ x: 10 + (200 - 400) / 2, y: 20, w: 400, h: 100 });
    const tall = getImageRect(portrait, cell, { x: 0, y: 0 }, 1);
    expect(tall).toEqual({ x: 10, y: 20 + (100 - 800) / 2, w: 200, h: 800 });
  });

  it("zoom scales about the centre and pan shifts the result", () => {
    const rect = getImageRect(landscape, cell, { x: 5, y: -7 }, 0.5);
    expect(rect).toEqual({ x: 10 + (200 - 200) / 2 + 5, y: 20 + (100 - 50) / 2 - 7, w: 200, h: 50 });
  });
});

describe("uncoveredStrips", () => {
  it("is empty for a cover-fit image at zoom 1, including float noise", () => {
    expect(uncoveredStrips(cell, getImageRect(landscape, cell, { x: 0, y: 0 }, 1))).toEqual([]);
    expect(uncoveredStrips(cell, getImageRect(portrait, cell, { x: 0, y: 0 }, 1))).toEqual([]);
    expect(uncoveredStrips(cell, { x: 10.3, y: 20.2, w: 199.5, h: 99.6 })).toEqual([]);
  });

  it("zooming out opens bands on the edges the image used to touch, without overlap", () => {
    // Landscape at zoom 0.5: 200×50 centred → 25px bands top and bottom, sides still covered.
    const strips = uncoveredStrips(cell, getImageRect(landscape, cell, { x: 0, y: 0 }, 0.5));
    expect(strips).toEqual([
      { x: 10, y: 20, w: 200, h: 25 },
      { x: 10, y: 95, w: 200, h: 25 },
    ]);
  });

  it("a pan opens a strip on the side the image moved away from", () => {
    // Zoom 1 landscape overshoots 100px on each side; a 120px pan right leaves 20px on the left.
    const strips = uncoveredStrips(cell, getImageRect(landscape, cell, { x: 120, y: 0 }, 1));
    expect(strips).toEqual([{ x: 10, y: 20, w: 20, h: 100 }]);
  });

  it("side strips sit between the bands, so a translucent fill never doubles up", () => {
    const strips = uncoveredStrips(cell, { x: 40, y: 30, w: 100, h: 50 });
    expect(strips).toEqual([
      { x: 10, y: 20, w: 200, h: 10 },
      { x: 10, y: 80, w: 200, h: 40 },
      { x: 10, y: 30, w: 30, h: 50 },
      { x: 140, y: 30, w: 70, h: 50 },
    ]);
    const area = strips.reduce((sum, s) => sum + s.w * s.h, 0);
    expect(area).toBe(200 * 100 - 100 * 50);
  });

  it("an image panned clear of the cell, or no image, leaves the whole cell", () => {
    expect(uncoveredStrips(cell, { x: 500, y: 20, w: 400, h: 100 })).toEqual([{ x: 10, y: 20, w: 200, h: 100 }]);
    expect(uncoveredStrips(cell, { x: -1000, y: -1000, w: 400, h: 100 })).toEqual([{ x: 10, y: 20, w: 200, h: 100 }]);
    expect(uncoveredStrips(cell, null)).toEqual([{ x: 10, y: 20, w: 200, h: 100 }]);
  });
});

describe("getPixelAlignedStrokeRect", () => {
  it("keeps every edge on device pixels at fractional canvas scales", () => {
    const ring = getPixelAlignedStrokeRect(
      { x: 0.35, y: 0.6, w: 101.2, h: 80.4 },
      1.25,
      1.251,
      3,
    );

    expect(ring).toEqual({
      outer: { x: 0, y: 1, w: 127, h: 100 },
      stroke: { x: 2, y: 3, w: 123, h: 96 },
      lineWidth: 4,
      radiusScale: 1.25,
    });

    const half = ring.lineWidth / 2;
    expect(ring.stroke.x - half).toBe(ring.outer.x);
    expect(ring.stroke.y - half).toBe(ring.outer.y);
    expect(ring.stroke.x + ring.stroke.w + half).toBe(ring.outer.x + ring.outer.w);
    expect(ring.stroke.y + ring.stroke.h + half).toBe(ring.outer.y + ring.outer.h);
  });

  it("uses an integer device-pixel width on high-density canvases", () => {
    const ring = getPixelAlignedStrokeRect(
      { x: 53.333, y: 24.667, w: 119.334, h: 96.666 },
      2,
      2,
      3,
    );

    expect(ring.lineWidth).toBe(6);
    expect(ring.outer).toEqual({ x: 107, y: 49, w: 238, h: 194 });
    expect(ring.stroke).toEqual({ x: 110, y: 52, w: 232, h: 188 });
  });
});

describe("blendedCellRect", () => {
  // Left / Right on a 1000×600 page with a 20px gap: cells at x 0–490 and 510–1000.
  const left = { x: 0, y: 0, w: 490, h: 600 };
  const right = { x: 510, y: 0, w: 490, h: 600 };
  const leftCell = { x: 0, y: 0, w: 0.5, h: 1 };
  const rightCell = { x: 0.5, y: 0, w: 0.5, h: 1 };

  it("reaches to the middle of the gap plus half the band on a shared edge only", () => {
    const a = blendedCellRect(left, leftCell, 20, 100);
    const b = blendedCellRect(right, rightCell, 20, 100);
    expect(a).toEqual({ x: 0, y: 0, w: 490 + 10 + 50, h: 600, ramps: { left: 0, right: 100, top: 0, bottom: 0 } });
    expect(b).toEqual({ x: 510 - 60, y: 0, w: 550, h: 600, ramps: { left: 100, right: 0, top: 0, bottom: 0 } });
  });

  it("the two ramps cover the same band, centred between the cells", () => {
    const a = blendedCellRect(left, leftCell, 20, 100);
    const b = blendedCellRect(right, rightCell, 20, 100);
    const aBand = [a.x + a.w - a.ramps.right, a.x + a.w];
    const bBand = [b.x, b.x + b.ramps.left];
    expect(aBand).toEqual(bBand);
    expect((aBand[0] + aBand[1]) / 2).toBe(500);
  });
});
