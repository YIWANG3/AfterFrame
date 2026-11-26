import { describe, expect, it } from "vitest";
import { coveredFieldsFromLogoVariants, fitLogoBounds, geometry, layoutRef, onPhotoPixels, resolveTokens } from "./frameRender";
import { FRAME_TEMPLATES, MOCKUP_TEMPLATE_ID } from "../frameTemplates";
import { mockupById } from "../mockups";
import { resolveCanvasPad } from "../imageMath";
import { mockupBodyPad } from "./mockupLayout";
import { withMockupFor } from "./mockupRender";

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

describe("templates with a canvas ratio", () => {
  it("widens the margins on the narrow axis until the output has the ratio", () => {
    // 3:2 landscape into 9:16: the extra goes evenly to top and bottom.
    const tpl = { canvas: { pad: { top: 0.04, right: 0.04, bottom: 0.04, left: 0.04 }, aspect: "9:16" } };
    const g = geometry({ width: 3000, height: 2000 }, tpl, {});
    expect(g.outW / g.outH).toBeCloseTo(9 / 16, 2);
    expect(g.padPx.left).toBeCloseTo(0.04 * 3000);
    expect(g.padPx.top).toBeCloseTo(g.padPx.bottom);
    expect(g.padPx.top).toBeGreaterThan(g.padPx.left);
  });

  it("widens left and right for a photo taller than the ratio", () => {
    const tpl = { canvas: { pad: { bottom: 0.1 }, aspect: "4:5" } };
    const g = geometry({ width: 2000, height: 3000 }, tpl, {});
    expect(g.outW / g.outH).toBeCloseTo(4 / 5, 2);
    expect(g.padPx.left).toBeCloseTo(g.padPx.right);
    expect(g.padPx.bottom).toBeCloseTo(0.1 * 3000);
  });
});

describe("text over photo pixels", () => {
  it("is the overlay family and any template whose margin is made of the photo", () => {
    expect(onPhotoPixels({ family: "overlay", canvas: {} })).toBe(true);
    expect(onPhotoPixels({ family: "photo-bg", canvas: { bg: { mode: "blur" } } })).toBe(true);
    expect(onPhotoPixels({ family: "photo-bg", canvas: { bg: { mode: "palette" } } })).toBe(true);
    expect(onPhotoPixels({ family: "bar", canvas: { bg: { type: "solid", color: "#ffffff" } } })).toBe(false);
  });

  it("covers every built-in that uses the photo as its background", () => {
    const photoBg = FRAME_TEMPLATES.filter((t) => ["blur", "palette"].includes(t.canvas?.bg?.mode));
    expect(photoBg.map((t) => t.id)).toEqual(["blur-card", "palette-card", "blur-story", "palette-45"]);
    for (const t of photoBg) expect(onPhotoPixels(t)).toBe(true);
  });

  it("keeps the first built-in (the default an agent gets) as it was", () => {
    expect(FRAME_TEMPLATES[0].id).toBe("bar-id");
  });
});

describe("camera mockup frame", () => {
  const tpl = FRAME_TEMPLATES.find((t) => t.id === MOCKUP_TEMPLATE_ID);
  const photo = { width: 3000, height: 2000 };
  const settled = withMockupFor(tpl, { make: "Canon", camera_model: "Canon EOS R5" }, photo.width, photo.height);

  it("settles the photo's own camera", () => {
    expect(settled.canvas.mockup.id).toBe("canon-eos-r5");
  });

  it("puts the template's margins around the camera, not the photo", () => {
    const g = geometry(photo, settled, { text: 1, margin: 1 });
    const body = mockupBodyPad(mockupById("canon-eos-r5"), settled.canvas.mockup, photo.width, photo.height);
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(g.bandPx[edge]).toBeCloseTo((tpl.canvas.pad[edge] || 0) * g.wref);
      expect(g.padPx[edge]).toBeCloseTo(g.bandPx[edge] + body[edge]);
    }
  });

  it("lays the canvas out as the editor does", () => {
    const g = geometry(photo, settled, { text: 1, margin: 1 });
    const short = Math.min(photo.width, photo.height);
    const k = g.wref / short;
    const userPad = Object.fromEntries(Object.entries(tpl.canvas.pad).map(([edge, v]) => [edge, v * k]));
    const editor = resolveCanvasPad({ pad: userPad, mockup: settled.canvas.mockup }, photo.width, photo.height);
    for (const edge of ["top", "right", "bottom", "left"]) expect(editor[edge] * short).toBeCloseTo(g.padPx[edge]);
  });
});
