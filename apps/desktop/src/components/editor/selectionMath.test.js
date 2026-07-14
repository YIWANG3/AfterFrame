import { describe, expect, it } from "vitest";

import { resizeRatio, snapAngle, snapAxis } from "./selectionMath";

describe("selectionMath", () => {
  it("snaps rotations only inside the threshold", () => {
    expect(snapAngle(2.9)).toBe(0);
    expect(snapAngle(3)).toBe(3);
    expect(snapAngle(88)).toBe(90);
  });

  it("computes symmetric resize ratios", () => {
    expect(resizeRatio({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 })).toBe(2);
    expect(resizeRatio({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 6, y: 8 })).toBe(1);
  });

  it("selects the nearest alignment candidate", () => {
    expect(snapAxis(50, 10, [39, 80], 3)).toEqual({
      dist: 1,
      center: 49,
      line: 39,
    });
    expect(snapAxis(50, 10, [20], 3)).toBeNull();
  });
});
