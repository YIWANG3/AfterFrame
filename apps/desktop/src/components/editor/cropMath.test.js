import { describe, expect, it } from "vitest";

import {
  createCenteredCrop,
  createDefaultCropRect,
  getAspectRatio,
  moveCropRect,
  symmetricResize,
} from "./cropMath";

describe("cropMath", () => {
  it("fits a requested aspect ratio inside the image bounds", () => {
    const crop = createDefaultCropRect({ width: 1000, height: 1000 }, 3 / 2);
    expect(crop.x).toBeCloseTo(0);
    expect(crop.y).toBeCloseTo(166.6667);
    expect(crop.width).toBeCloseTo(1000);
    expect(crop.height).toBeCloseTo(666.6667);
  });

  it("clamps crop movement to the image bounds", () => {
    expect(moveCropRect(
      { x: 100, y: 100, width: 300, height: 200 },
      { width: 500, height: 400 },
      1000,
      -1000,
    )).toEqual({ x: 200, y: 0, width: 300, height: 200 });
  });

  it("resolves original aspect presets and creates centered crops", () => {
    expect(getAspectRatio("original", 4 / 3)).toBe(4 / 3);
    expect(createCenteredCrop(800, 600, 1, 400, 300)).toEqual({
      x: 100,
      y: 0,
      width: 600,
      height: 600,
    });
  });

  it("keeps symmetric resize centered", () => {
    const crop = symmetricResize(
      { x: 100, y: 100, width: 200, height: 100 },
      "e",
      { x: 350, y: 150 },
      2,
    );
    expect(crop).toEqual({ x: 50, y: 75, width: 300, height: 150 });
  });
});
