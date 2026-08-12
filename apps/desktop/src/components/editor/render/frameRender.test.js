import { describe, expect, it } from "vitest";
import { coveredFieldsFromLogoVariants, fitLogoBounds, resolveTokens } from "./frameRender";

describe("frame logo bounds", () => {
  it("moves a rotated wordmark down when its top edge would be clipped", () => {
    const fitted = fitLogoBounds({
      x: 0.9,
      y: 0.1,
      scale: 0.12,
      aspect: 5.37,
      rotation: 90,
      outW: 1600,
      outH: 900,
      clampY: true,
      edgeInsetY: 0.02,
    });

    expect(fitted.y - fitted.h / 2).toBeCloseTo(0.02);
    expect(fitted.y + fitted.h / 2).toBeLessThanOrEqual(0.98);
  });

  it("shrinks an unusually long rotated mark to fit the canvas", () => {
    const fitted = fitLogoBounds({
      x: 0.9,
      y: 0.1,
      scale: 0.8,
      aspect: 5.37,
      rotation: 90,
      outW: 1600,
      outH: 900,
      clampY: true,
      edgeInsetY: 0.02,
    });

    expect(fitted.h).toBeCloseTo(0.96);
    expect(fitted.y).toBeCloseTo(0.5);
  });

  it("does not move an unrotated logo when clamping is disabled", () => {
    const fitted = fitLogoBounds({
      x: 0.5,
      y: 0.1,
      scale: 0.12,
      aspect: 5.37,
      rotation: 0,
      outW: 1600,
      outH: 900,
    });

    expect(fitted.y).toBe(0.1);
    expect(fitted.scale).toBe(0.12);
  });
});

describe("product lockup text coverage", () => {
  const exif = { camera_model: "Luna Ultra", lens_model: "Leica Summicron" };

  it("removes a camera model already included in the rendered logo", () => {
    const covered = coveredFieldsFromLogoVariants([{ covers: ["camera_model"] }]);

    expect(resolveTokens("{camera_model}", exif, {}, covered)).toBe("");
    expect(resolveTokens("{lens_model}", exif, {}, covered)).toBe("Leica Summicron");
  });

  it("keeps the camera model for generic brand marks", () => {
    const covered = coveredFieldsFromLogoVariants([{}]);

    expect(resolveTokens("{camera_model}", exif, {}, covered)).toBe("Luna Ultra");
  });
});
