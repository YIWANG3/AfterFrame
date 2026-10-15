import { describe, expect, it } from "vitest";
import { cropRectToPixels } from "./bakeCrop";

describe("cropRectToPixels", () => {
  it("maps the screen crop box into the transformed photo's pixels", () => {
    const imageRect = { x: 100, y: 50, width: 400, height: 300 };
    const cropRect = { x: 200, y: 125, width: 200, height: 150 };
    expect(cropRectToPixels(cropRect, imageRect, 4000, 3000)).toEqual({ x: 1000, y: 750, width: 2000, height: 1500 });
  });

  it("scales each axis on its own when the screen rect is not to scale", () => {
    const imageRect = { x: 0, y: 0, width: 200, height: 100 };
    const cropRect = { x: 50, y: 25, width: 100, height: 50 };
    expect(cropRectToPixels(cropRect, imageRect, 1000, 1000)).toEqual({ x: 250, y: 250, width: 500, height: 500 });
  });

  it("keeps a box reaching past the photo (a free angle) unclamped", () => {
    const imageRect = { x: 100, y: 100, width: 100, height: 100 };
    const cropRect = { x: 80, y: 90, width: 140, height: 120 };
    expect(cropRectToPixels(cropRect, imageRect, 100, 100)).toEqual({ x: -20, y: -10, width: 140, height: 120 });
  });
});
