import { describe, expect, it } from "vitest";
import {
  MOCKUPS, GENERIC_MOCKUPS, mockupBrandOf, mockupById, mockupMatchFor, mockupOfMaker, modelKey, pickMockupId, resolveMockupSpec,
} from "./mockups";

const LIST = [
  { id: "hasselblad-907x", brand: "hasselblad", name: "Hasselblad 907X & CFV 100C", match: ["CFV 100C/907X", "CFV II 50C/907X"], brandDefault: true },
  { id: "leica-m11-p", brand: "leica", name: "Leica M11-P", match: ["M11-P", "M11"], brandDefault: true },
  { id: "canon-eos-r6-ii", brand: "canon", name: "Canon EOS R6 Mark II", match: ["EOS R6 Mark II", "EOS R6m2"] },
  { id: "canon-eos-r6-iii", brand: "canon", name: "Canon EOS R6 Mark III", match: ["EOS R6 Mark III"], brandDefault: true },
  { id: "nikon-z6-ii", brand: "nikon", name: "Nikon Z6II", match: ["Z 6_2", "Z 7_2"] },
  { id: "sony-a7-iv", brand: "sony", name: "Sony α7 IV", match: ["ILCE-7M4"], brandDefault: true },
  { id: "ricoh-gr-iii", brand: "ricoh", name: "Ricoh GR III", match: ["GR III", "GR IIIx"], brandDefault: true },
  { id: "pentax-k-1-ii", brand: "pentax", name: "Pentax K-1 Mark II", match: ["K-1 Mark II"], brandDefault: true },
];
const GENERIC = { landscape: "hasselblad-907x", portrait: "leica-m11-p" };
const pick = (exif, portrait = false) => pickMockupId(exif, { portrait, list: LIST, generic: GENERIC });

describe("camera model names", () => {
  it("compares names without the maker, case, spaces or punctuation", () => {
    expect(modelKey("NIKON Z 6_2")).toBe("z62");
    expect(modelKey("LEICA M11-P")).toBe("m11p");
    expect(modelKey("Canon EOS R6m2")).toBe("eosr6m2");
    expect(modelKey("Sony α7 IV")).toBe("a7iv");
    expect(modelKey("RICOH GR IIIx")).toBe("griiix");
  });

  it("tells the maker from Make and Model", () => {
    expect(mockupBrandOf({ make: "LEICA CAMERA AG", camera_model: "LEICA M11" })).toBe("leica");
    expect(mockupBrandOf({ make: "NIKON CORPORATION", camera_model: "NIKON Z f" })).toBe("nikon");
    expect(mockupBrandOf({ make: "OM Digital Solutions", camera_model: "OM-1MarkII" })).toBe("om");
    // Pentax bodies say RICOH IMAGING in Make.
    expect(mockupBrandOf({ make: "RICOH IMAGING COMPANY, LTD.", camera_model: "PENTAX K-1 Mark II" })).toBe("pentax");
    expect(mockupBrandOf({ make: "RICOH IMAGING COMPANY, LTD.", camera_model: "RICOH GR III" })).toBe("ricoh");
    expect(mockupBrandOf({ make: "Apple", camera_model: "iPhone 16 Pro" })).toBe(null);
  });
});

describe("picking a camera for a photo", () => {
  it("picks the photo's own camera by its EXIF model", () => {
    expect(pick({ make: "Canon", camera_model: "Canon EOS R6m2" })).toBe("canon-eos-r6-ii");
    expect(pick({ make: "NIKON CORPORATION", camera_model: "NIKON Z 7_2" })).toBe("nikon-z6-ii");
    expect(pick({ make: "SONY", camera_model: "ILCE-7M4" })).toBe("sony-a7-iv");
    expect(pick({ make: "Hasselblad", camera_model: "CFV II 50C/907X" })).toBe("hasselblad-907x");
    expect(pick({ make: "RICOH IMAGING COMPANY, LTD.", camera_model: "RICOH GR IIIx" })).toBe("ricoh-gr-iii");
  });

  it("matches the camera's display name too", () => {
    expect(pick({ make: "SONY", camera_model: "ILCE-0000", camera_label: "α7 IV" })).toBe("sony-a7-iv");
  });

  it("gives a camera with no picture its maker's usual one", () => {
    expect(pick({ make: "Canon", camera_model: "Canon EOS R8" })).toBe("canon-eos-r6-iii");
    expect(pick({ make: "RICOH IMAGING COMPANY, LTD.", camera_model: "PENTAX KF" })).toBe("pentax-k-1-ii");
  });

  it("says how well the photo's camera is matched", () => {
    expect(mockupMatchFor({ make: "Canon", camera_model: "Canon EOS R6m2" }, LIST)).toBe("model");
    expect(mockupMatchFor({ make: "Canon", camera_model: "Canon EOS R8" }, LIST)).toBe("brand");
    expect(mockupMatchFor({ make: "Apple", camera_model: "iPhone XS Max" }, LIST)).toBe("none");
    expect(mockupMatchFor({}, LIST)).toBe("none");
  });

  it("gives an unknown camera the generic one for the photo's orientation", () => {
    expect(pick({ make: "Apple", camera_model: "iPhone 16 Pro" })).toBe("hasselblad-907x");
    expect(pick({ make: "Apple", camera_model: "iPhone 16 Pro" }, true)).toBe("leica-m11-p");
    expect(pick({})).toBe("hasselblad-907x");
  });
});

describe("the bundled mockups", () => {
  it("has a picture, a display inside it and a unique id for every camera", () => {
    expect(MOCKUPS.length).toBeGreaterThan(0);
    expect(new Set(MOCKUPS.map((m) => m.id)).size).toBe(MOCKUPS.length);
    for (const m of MOCKUPS) {
      expect(m.size[0]).toBeGreaterThan(0);
      const s = m.screen;
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(1);
      expect(s.y + s.h).toBeLessThanOrEqual(1);
    }
    expect(mockupById(GENERIC_MOCKUPS.landscape)).toBeTruthy();
    expect(mockupById(GENERIC_MOCKUPS.portrait)).toBeTruthy();
  });

  it("matches no EXIF model to two cameras", () => {
    const seen = new Map();
    for (const m of MOCKUPS) {
      for (const name of m.match) {
        // Two spellings of one camera's model may meet; two cameras may not.
        const key = `${m.brand}:${modelKey(name)}`;
        expect(seen.get(key) ?? m.id, `${name} in ${m.id} and ${seen.get(key)}`).toBe(m.id);
        seen.set(key, m.id);
      }
    }
  });

  it("knows a camera of the photo's own maker", () => {
    expect(mockupOfMaker("canon-eos-r5", { make: "Canon", camera_model: "Canon EOS R8" })).toBe(true);
    expect(mockupOfMaker("leica-m11-p", { make: "Apple", camera_model: "iPhone XS Max" })).toBe(false);
    expect(mockupOfMaker("fujifilm-x100vi", { make: "Canon", camera_model: "Canon EOS R5" })).toBe(false);
  });

  it("settles a template's camera for a photo", () => {
    const spec = resolveMockupSpec({ id: "auto", fit: "fill" }, { make: "Canon", camera_model: "Canon EOS R5" }, 3000, 2000);
    expect(spec).toEqual({ id: "canon-eos-r5", fit: "fill", rotation: "auto", layout: "screen", reflection: false, exposure: 0, radius: 0 });
    expect(resolveMockupSpec({ id: "auto", exposure: 250 }, {}, 3000, 2000).exposure).toBe(100);
    // A camera that is no longer there is replaced by the photo's own.
    expect(resolveMockupSpec({ id: "gone" }, {}, 2000, 3000).id).toBe(GENERIC_MOCKUPS.portrait);
  });
});
