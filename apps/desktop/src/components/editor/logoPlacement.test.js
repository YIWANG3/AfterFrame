import { describe, expect, it } from "vitest";
import { backgroundLightness, layerBoxes, placeLogo, placeText, swapLogo } from "./logoPlacement";
import { outputGeometry } from "./frameUserTemplates";

const measure = (text, { fontPx }) => String(text).length * fontPx * 0.5;
const BAR = { top: 0, right: 0, bottom: 0.12, left: 0 };

describe("where my logo goes", () => {
  it("into a bottom bar: its right end, 34% of the bar tall, centred in it", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const spot = placeLogo({ geom, pad: BAR, aspect: 3 });
    expect(spot.region).toBe("bottom");
    expect(spot.height).toBeCloseTo(0.12 * 2000 * 0.4 * 0.85, 6); // 81.6px
    expect(spot.width).toBeCloseTo(spot.height * 3, 6);
    expect(spot.cy).toBeCloseTo(2000 + 240 / 2, 6);
    expect(geom.outW - (spot.cx + spot.width / 2)).toBeCloseTo(0.075 * 2000, 6); // 150px in from the right
  });

  it("slides left from the bar's right end to the first gap clear of what is there", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const brand = { type: "sticker", x: 2800 / 3000, y: 2120 / 2000, scale: 0.05, naturalWidth: 100, naturalHeight: 100 };
    const boxes = layerBoxes([brand], geom, measure);
    const spot = placeLogo({ geom, pad: BAR, aspect: 3, occupied: boxes });
    // Just left of the brand logo (at x 2725..2875), a 60px gap (0.03 × 2000) between.
    const gap = 60;
    expect(spot.cx + spot.width / 2 + gap).toBeLessThanOrEqual(boxes[0].x + 1e-6);
    expect(boxes[0].x - (spot.cx + spot.width / 2 + gap)).toBeLessThan(gap);
  });

  it("a full bar gives the spot that overlaps least", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const wall = [{ x: 0, y: 2000, w: 1400, h: 240 }, { x: 1600, y: 2000, w: 1400, h: 240 }];
    const spot = placeLogo({ geom, pad: BAR, aspect: 3, occupied: wall });
    // Over the narrow opening in the middle (any spot across it overlaps as little).
    expect(Math.abs(spot.cx - 1500)).toBeLessThan(120);
  });

  it("a very wide logo is held to under half the bar's width", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const spot = placeLogo({ geom, pad: BAR, aspect: 20 });
    expect(spot.width).toBeCloseTo(3000 * 0.45, 6);
    expect(spot.height).toBeCloseTo(spot.width / 20, 6);
  });

  it("with only a top band, in the top band; with none, the photo's corner", () => {
    const top = { top: 0.1 };
    const topGeom = outputGeometry({ fullW: 2000, fullH: 3000, pad: top });
    expect(placeLogo({ geom: topGeom, pad: top, aspect: 2 })).toMatchObject({ region: "top", cy: 100 });
    // A hairline border is not a bar.
    const thin = { top: 0.01, right: 0.01, bottom: 0.01, left: 0.01 };
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, crop: { x: 0.1, y: 0, width: 0.8, height: 1 }, pad: thin });
    const spot = placeLogo({ geom, pad: thin, aspect: 2 });
    expect(spot.region).toBe("photo");
    expect(spot.height).toBeCloseTo(0.06 * 0.85 * 2000, 6);
    expect(geom.left + geom.contentW - (spot.cx + spot.width / 2)).toBeCloseTo(0.075 * 2000, 6);
  });

  it("reads a background's lightness to choose black or white", () => {
    expect(backgroundLightness({ color: "#ffffff" })).toBeCloseTo(1, 6);
    expect(backgroundLightness({ color: "#0c0c0c" })).toBeLessThan(0.1);
    expect(backgroundLightness({ mode: "gradient", gradient: { from: "#000000", to: "#ffffff" } })).toBeCloseTo(0.5, 6);
    expect(backgroundLightness(null)).toBeCloseTo(1, 6); // a margin with no colour set is white
  });

  it("a line of text goes to a bar's left end, then its centre; with no bar, the photo's bottom-left", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const widthAt = (fontPx) => 12 * fontPx * 0.5; // a 12-character line
    const first = placeText({ geom, pad: BAR, widthAt });
    expect(first.fontPx).toBeCloseTo(240 * 0.2, 6);
    expect(first.cx - widthAt(first.fontPx) / 2).toBeCloseTo(150, 6);
    expect(first.cy).toBeCloseTo(2120, 6);
    // Something at the left end: the line starts just after it, a gap between.
    const taken = [{ x: 100, y: 2080, w: 400, h: 80 }];
    const next = placeText({ geom, pad: BAR, widthAt, occupied: taken });
    const nextLeft = next.cx - widthAt(next.fontPx) / 2;
    expect(nextLeft - 60).toBeGreaterThanOrEqual(500 - 1e-6);
    expect(nextLeft - 60 - 500).toBeLessThan(60);
    // A secondary line is smaller.
    expect(placeText({ geom, pad: BAR, widthAt, scale: 0.75 }).fontPx).toBeCloseTo(36, 6);

    const bare = outputGeometry({ fullW: 3000, fullH: 2000 });
    const corner = placeText({ geom: bare, pad: null, widthAt });
    expect(corner.region).toBe("photo");
    expect(corner.fontPx).toBeCloseTo(0.035 * 2000, 6);
    expect(corner.cx - widthAt(corner.fontPx) / 2).toBeCloseTo(150, 6);
  });

  it("a line too long for the frame is shrunk to fit", () => {
    const geom = outputGeometry({ fullW: 1000, fullH: 1000, pad: BAR });
    const widthAt = (fontPx) => 200 * fontPx * 0.5;
    const spot = placeText({ geom, pad: BAR, widthAt });
    expect(widthAt(spot.fontPx)).toBeCloseTo(1000 - 2 * 75, 6);
  });

  it("a logo swapped for another shape keeps its end of the bar and its weight", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    // A wordmark (4:1) at the bar's right end: 400 × 100 px, right edge at 2850.
    const right = { x: 2650 / 3000, y: 2120 / 2000, scale: 400 / 3000, naturalWidth: 400, naturalHeight: 100 };
    const square = swapLogo({ layer: right, geom, aspect: 1 });
    const w = square.scale * 3000;
    expect(square.x * 3000 + w / 2).toBeCloseTo(2850, 6); // right edge held
    expect(w).toBeCloseTo(100 * (0.68 / 0.45), 6); // a square mark is drawn taller, as templates do
    // At the left end the left edge is held; in the middle, the centre.
    const left = { ...right, x: 350 / 3000 };
    const swapped = swapLogo({ layer: left, geom, aspect: 1 });
    expect(swapped.x * 3000 - (swapped.scale * 3000) / 2).toBeCloseTo(150, 6);
    const middle = { ...right, x: 0.5 };
    expect(swapLogo({ layer: middle, geom, aspect: 1 }).x).toBeCloseTo(0.5, 6);
    // Same shape: nothing moves.
    expect(swapLogo({ layer: right, geom, aspect: 4 })).toMatchObject({ x: right.x, scale: right.scale });
  });
});
