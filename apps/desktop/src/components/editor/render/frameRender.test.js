import { describe, expect, it } from "vitest";
import { coveredFieldsFromLogoVariants, fitLogoBounds, geometry, layoutRef, resolveTokens } from "./frameRender";

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

describe("frame layout reference", () => {
  const tpl = { canvas: { pad: { bottom: 0.1 } } };

  it("is the photo width for a 3:2 landscape (templates' native aspect)", () => {
    expect(layoutRef(3000, 2000)).toBe(3000);
    const g = geometry({ width: 3000, height: 2000 }, tpl, {});
    expect(g.wref).toBe(3000);
    expect(g.photoW).toBe(3000);
    expect(g.padPx.bottom).toBeCloseTo(300);
    expect(g.outW).toBe(3000);
    expect(g.outH).toBe(2300);
  });

  it("gives portrait and panoramic photos the same chrome weight relative to the short edge", () => {
    // 4:5 portrait and a ~1.86:1 panorama with the same short edge → same
    // layout reference, so a 5%-of-wref logo is the same fraction of the
    // picture's short side on both (was 5% of the WIDTH: 2× taller on the pano).
    const portrait = geometry({ width: 3943, height: 4320 }, tpl, {});
    const pano = geometry({ width: 7680, height: 4135 }, tpl, {});
    expect(portrait.wref).toBeCloseTo(3943 * 1.5);
    expect(pano.wref).toBeCloseTo(4135 * 1.5);
    expect(portrait.wref / Math.min(3943, 4320)).toBeCloseTo(pano.wref / Math.min(7680, 4135));
    // The photo itself still draws at its real width.
    expect(pano.photoW).toBe(7680);
    expect(pano.outW).toBe(7680);
    expect(portrait.outW).toBe(3943);
  });
});
