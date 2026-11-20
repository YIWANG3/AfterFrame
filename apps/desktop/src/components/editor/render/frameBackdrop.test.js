import { describe, expect, it } from "vitest";
import {
  bgBlurPx, bgUsesPhoto, colorDelta, dominantColor, paletteFromPixels,
  photoRadiusPx, photoShadow, photoStyleCss, textBgRadius, vividHex,
} from "./frameBackdrop";
import { aspectRatioOf, canvasActive, resolveCanvasPad } from "../imageMath";

// An N×N RGBA buffer: the top half one colour, the bottom half another.
function split(size, top, bottom) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const [r, g, b] = y < size / 2 ? top : bottom;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}

const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hue = (hex) => {
  const [r, g, b] = rgbOf(hex);
  return r >= g && r >= b ? "r" : g >= b ? "g" : "b";
};
const lightness = (hex) => {
  const c = rgbOf(hex);
  return (Math.max(...c) + Math.min(...c)) / 510;
};

describe("photo colours", () => {
  it("takes the top colour from the top of the photo and the bottom from the bottom", () => {
    const p = paletteFromPixels(split(20, [40, 90, 200], [200, 120, 30]), 20);
    expect(hue(p.top)).toBe("b");
    expect(hue(p.bottom)).toBe("r");
  });

  it("lets a saturated hue win over a larger grey area", () => {
    const size = 10;
    const data = split(size, [128, 128, 128], [128, 128, 128]);
    for (let i = 0; i < 30; i++) { data[i * 4] = 220; data[i * 4 + 1] = 40; data[i * 4 + 2] = 40; }
    const [r, g, b] = dominantColor(data, size, 0, size);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it("keeps a grey photo grey and away from black and white", () => {
    expect(vividHex([10, 10, 10])).toBe("#525252");
    expect(vividHex([250, 250, 250])).toBe("#adadad");
  });

  it("gives the ends two different colours when top and bottom look alike", () => {
    // A gold frame on a navy wall, the same at the top and the bottom: gold
    // wins both regions on saturation, so one end takes the wall's blue.
    const size = 20;
    const data = split(size, [0, 0, 0], [0, 0, 0]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const c = x < 9 ? [25, 50, 110] : x < 15 ? [185, 130, 35] : [60, 60, 60];
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
      }
    }
    const p = paletteFromPixels(data, size);
    expect(new Set([hue(p.top), hue(p.bottom)])).toEqual(new Set(["r", "b"]));
    expect(colorDelta(rgbOf(p.top), rgbOf(p.bottom))).toBeGreaterThan(20);
  });

  it("makes a one-colour photo lighter at the end where the photo is lighter", () => {
    const down = paletteFromPixels(split(20, [70, 130, 235], [20, 45, 130]), 20);
    expect([hue(down.top), hue(down.bottom)]).toEqual(["b", "b"]);
    expect(lightness(down.top) - lightness(down.bottom)).toBeGreaterThan(0.2);
    const up = paletteFromPixels(split(20, [20, 45, 130], [70, 130, 235]), 20);
    expect(lightness(up.bottom) - lightness(up.top)).toBeGreaterThan(0.2);
    // A flat photo: the top is the lighter end.
    const flat = paletteFromPixels(split(20, [40, 90, 200], [40, 90, 200]), 20);
    expect(lightness(flat.top) - lightness(flat.bottom)).toBeGreaterThan(0.2);
  });

  it("does not hand an end to a small accent", () => {
    // Blue all over with a few orange lights low down: both ends stay blue.
    const size = 20;
    const data = split(size, [40, 90, 200], [30, 60, 160]);
    for (let x = 0; x < 6; x++) {
      const i = ((size - 2) * size + x) * 4;
      data[i] = 230; data[i + 1] = 120; data[i + 2] = 20;
    }
    const p = paletteFromPixels(data, size);
    expect([hue(p.top), hue(p.bottom)]).toEqual(["b", "b"]);
  });

  it("leaves two ends that already differ alone", () => {
    const p = paletteFromPixels(split(20, [40, 90, 200], [200, 120, 30]), 20);
    expect(colorDelta(rgbOf(p.top), rgbOf(vividHex([40, 90, 200])))).toBeLessThan(1);
    expect(colorDelta(rgbOf(p.bottom), rgbOf(vividHex([200, 120, 30])))).toBeLessThan(1);
  });
});

describe("canvas ratio", () => {
  it("reads w:h ratios and nothing else", () => {
    expect(aspectRatioOf("9:16")).toBeCloseTo(0.5625);
    expect(aspectRatioOf("1:1")).toBe(1);
    expect(aspectRatioOf(null)).toBeNull();
    expect(aspectRatioOf("wide")).toBeNull();
    expect(aspectRatioOf("0:3")).toBeNull();
  });

  it("is active with a ratio even without margins", () => {
    expect(canvasActive({ pad: { top: 0, right: 0, bottom: 0, left: 0 }, aspect: null })).toBe(false);
    expect(canvasActive({ pad: { top: 0, right: 0, bottom: 0, left: 0 }, aspect: "4:5" })).toBe(true);
  });

  it("widens a landscape photo's margins top and bottom to reach 9:16", () => {
    const pad = resolveCanvasPad({ pad: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, aspect: "9:16" }, 3000, 2000);
    const s = 2000;
    const W = 3000 + (pad.left + pad.right) * s;
    const H = 2000 + (pad.top + pad.bottom) * s;
    expect(W / H).toBeCloseTo(9 / 16, 6);
    expect(pad.left).toBeCloseTo(0.05);
    expect(pad.top).toBeCloseTo(pad.bottom);
  });

  it("widens a tall photo's margins left and right to reach 1:1", () => {
    const pad = resolveCanvasPad({ pad: { top: 0, right: 0, bottom: 0.1, left: 0 }, aspect: "1:1" }, 1000, 1500);
    const W = 1000 + (pad.left + pad.right) * 1000;
    const H = 1500 + (pad.top + pad.bottom) * 1000;
    expect(W).toBeCloseTo(H, 6);
    expect(pad.left).toBeCloseTo(pad.right);
    expect(pad.bottom).toBeCloseTo(0.1);
  });

  it("leaves the margins alone without a ratio", () => {
    const pad = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 };
    expect(resolveCanvasPad({ pad, aspect: null }, 300, 200)).toEqual(pad);
  });
});

describe("the photo's corners and shadow", () => {
  it("scales with the short edge", () => {
    expect(photoRadiusPx({ radius: 100 }, 1000)).toBeCloseTo(100);
    expect(photoRadiusPx({ radius: 50 }, 2000)).toBeCloseTo(100);
    expect(photoRadiusPx(null, 1000)).toBe(0);
  });

  it("has no shadow at zero and the same numbers for canvas and CSS", () => {
    expect(photoShadow({ shadow: 0 }, 1000)).toBeNull();
    const sh = photoShadow({ shadow: 100 }, 1000);
    expect(sh.blur).toBeCloseTo(90);
    const css = photoStyleCss({ radius: 10, shadow: 100 }, 1000);
    expect(parseFloat(css.borderRadius)).toBeCloseTo(10);
    expect(css.boxShadow).toBe(`0 ${sh.offsetY}px ${sh.blur}px ${sh.color}`);
  });
});

describe("backgrounds", () => {
  it("knows which ones are made from the photo", () => {
    expect(bgUsesPhoto({ mode: "palette" })).toBe(true);
    expect(bgUsesPhoto({ mode: "blur" })).toBe(true);
    expect(bgUsesPhoto({ mode: "gradient" })).toBe(false);
    expect(bgUsesPhoto(null)).toBe(false);
  });

  it("blurs by a share of the short edge", () => {
    expect(bgBlurPx({ blur: 100 }, 1000)).toBeCloseTo(80);
    expect(bgBlurPx({ blur: 0 }, 1000)).toBe(0);
  });
});

describe("a text background's corners", () => {
  it("are square by default and a share of half the short side", () => {
    expect(textBgRadius({ bgMode: "solid" }, 200, 40)).toBe(0);
    expect(textBgRadius({ bgMode: "solid", bgRadius: 50 }, 200, 40)).toBe(10);
    expect(textBgRadius({ bgMode: "solid", bgRadius: 100 }, 200, 40)).toBe(20);
  });
});
