import { describe, expect, it } from "vitest";

import {
  createCenteredCrop,
  getAspectRatio,
  symmetricResize,
} from "./cropMath";

describe("cropMath", () => {
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
