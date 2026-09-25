import { describe, expect, it } from "vitest";
import {
  dropEditedSources, layersFromTemplate, outputGeometry, templateFromLayers, tokenSourceOf,
} from "./frameUserTemplates";

// Monospace stand-in for the DOM measure: half an em per character.
const measure = (text, { fontPx }) => String(text).length * fontPx * 0.5;
const PAD = { top: 0, right: 0, bottom: 0.12, left: 0 };
const exif = { camera_model: "Canon EOS R5", lens_model: "RF 24-70mm", aperture: 8, shutter_speed: 0.004, iso: 100 };

// A bottom bar on a 3000×2000 photo, as the editor stores it (full-photo
// fractions, sizes against the photo width): the model at the bar's left, the
// logo at its right, a typed caption centred on the photo.
const landscape = outputGeometry({ fullW: 3000, fullH: 2000, pad: PAD });
function storedLayer(outX, outY, rest) {
  return { ...rest, x: (outX - landscape.left) / 3000, y: (outY - landscape.top) / 2000 };
}
const model = storedLayer(0, 0, {
  id: "t1", type: "text", text: "Canon EOS R5", tokenSource: { content: "{camera_model}" },
  fontFamily: "Outfit", fontWeight: 400, fontSize: 64, shadowBlur: 0, shadowX: 0, shadowY: 0, strokeWidth: 0, rotation: 0, fromPreset: true,
});
const fontPx = (64 * 3000) / 1920; // 100 px
const modelW = measure("Canon EOS R5", { fontPx });
Object.assign(model, { x: (150 + modelW / 2) / 3000, y: (2000 + 120) / 2000 }); // left edge 150px (0.075 short edges) into the bar
const logo = { id: "s1", type: "sticker", logoRef: { variant: "symbol" }, stickerPath: "data:image/png;base64,AAAA", naturalWidth: 200, naturalHeight: 100,
  scale: 0.04, rotation: 0, fromPreset: true, x: (3000 - 150 - 60) / 3000, y: 2120 / 2000 };
const caption = { id: "t2", type: "text", text: "Tokyo", fontFamily: "Outfit", fontWeight: 400, fontSize: 96, rotation: 0, x: 0.5, y: 0.5 };
const handwriting = { id: "s2", type: "sticker", stickerPath: "data:image/png;base64,BBBB", naturalWidth: 10, naturalHeight: 10, scale: 0.1, x: 0.2, y: 0.2 };

function save(layers = [model, logo, caption]) {
  return templateFromLayers({ id: "user:1", name: "Bar", layers, geom: landscape, pad: PAD, bg: { color: "#ffffff" }, measure });
}
const logoFor = () => ({ src: "data:logo-for-this-camera", naturalWidth: 300, naturalHeight: 100 });

describe("user frame templates", () => {
  it("keeps the margins, pins each layer to its nearest edge, and stores no logo pixels", () => {
    const { template, skipped } = save([model, logo, caption, handwriting]);
    expect(skipped).toBe(1); // the handwriting sticker is only a data: URL
    expect(template.canvas.pad).toEqual(PAD);
    const [text, mark, centred] = template.layers;
    expect(text.pin.h).toEqual({ edge: "left", d: expect.closeTo(0.075, 6) });
    expect(text.pin.v.edge).toBe("bottom");
    expect(text.tokenSource).toEqual({ content: "{camera_model}" });
    expect(mark.pin.h.edge).toBe("right");
    expect(mark.stickerPath).toBeUndefined();
    expect(centred.pin.h).toEqual({ edge: "center", d: 0 });
    expect(JSON.stringify(template)).not.toContain("data:");
  });

  it("puts the layers back where they were on the photo it was saved from", () => {
    const layers = layersFromTemplate(save().template, { geom: landscape, exif, profile: {}, measure, logoFor: () => ({ src: "x", naturalWidth: 200, naturalHeight: 100 }) });
    const expected = [model, logo, caption].map((l) => ({
      x: (l.x * 3000 + landscape.left) / landscape.outW, y: (l.y * 2000 + landscape.top) / landscape.outH,
    }));
    layers.forEach((layer, i) => {
      expect(layer.x).toBeCloseTo(expected[i].x, 6);
      expect(layer.y).toBeCloseTo(expected[i].y, 6);
    });
    // Sizes come back against the output width.
    expect(layers[0].fontSize).toBeCloseTo((fontPx * 1920) / landscape.outW, 6);
  });

  it("on a portrait photo the bar keeps its proportions and each edge its distance", () => {
    const portrait = outputGeometry({ fullW: 2000, fullH: 3000, pad: PAD });
    const other = { ...exif, camera_model: "Canon EOS R6 Mark II" };
    const [text, mark] = layersFromTemplate(save().template, { geom: portrait, exif: other, profile: {}, measure, logoFor });
    // Re-resolved for this camera, and its LEFT edge (not its centre) stays put.
    expect(text.text).toBe("Canon EOS R6 Mark II");
    const px = (text.fontSize * portrait.outW) / 1920;
    expect(px).toBeCloseTo(100, 6); // same short edge (2000), same size
    expect(text.x * portrait.outW - measure(text.text, { fontPx: px }) / 2).toBeCloseTo(150, 6);
    // Same distance above the bottom of the (same-height) bar.
    expect(portrait.outH - text.y * portrait.outH).toBeCloseTo(landscape.outH - model.y * 2000, 6);
    // The logo is this camera's, its height kept, its right edge 150px in.
    expect(mark.stickerPath).toBe("data:logo-for-this-camera");
    const widthPx = mark.scale * portrait.outW;
    expect(widthPx / 3).toBeCloseTo((0.04 * 3000) / 2, 6); // height unchanged: 60px
    expect(portrait.outW - (mark.x * portrait.outW + widthPx / 2)).toBeCloseTo(150, 6);
  });

  it("leaves out a token or a logo the new photo has nothing for", () => {
    const layers = layersFromTemplate(save().template, { geom: landscape, exif: {}, profile: {}, measure, logoFor: () => null });
    expect(layers.map((l) => l.text ?? l.type)).toEqual(["Tokyo"]);
  });

  it("an EXIF row and {author} resolve from the photo and the profile", () => {
    expect(tokenSourceOf({ type: "exif", fields: ["aperture", "iso"], labeled: false })).toEqual({ exif: { fields: ["aperture", "iso"], labeled: false } });
    expect(tokenSourceOf({ type: "text", content: "Shanghai" })).toBeNull();
    const { template } = save([{ ...caption, text: "", tokenSource: { content: "© {author}" } }]);
    const [signed] = layersFromTemplate(template, { geom: landscape, exif, profile: { author: "Yi" }, measure, logoFor });
    expect(signed.text).toBe("© Yi");
  });

  it("retyping a token's text drops its source; other edits keep it", () => {
    const moved = dropEditedSources([{ ...model, x: 0.3 }], [model]);
    expect(moved[0].tokenSource).toEqual({ content: "{camera_model}" });
    const retyped = dropEditedSources([{ ...model, text: "My camera" }], [model]);
    expect(retyped[0].tokenSource).toBeUndefined();
    const same = [model];
    expect(dropEditedSources(same, [model])).toBe(same);
  });
});
