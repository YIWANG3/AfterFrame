import { describe, expect, it } from "vitest";

import { getPixelAlignedStrokeRect } from "./collageRender";

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
