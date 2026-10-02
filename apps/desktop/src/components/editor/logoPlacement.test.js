import { describe, expect, it } from "vitest";
import { backgroundLightness, layerBoxes, placeLogo } from "./logoPlacement";
import { outputGeometry } from "./frameUserTemplates";

const measure = (text, { fontPx }) => String(text).length * fontPx * 0.5;
const BAR = { top: 0, right: 0, bottom: 0.12, left: 0 };

describe("where my logo goes", () => {
  it("into a bottom bar: its right end, 40% of the bar tall, centred in it", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const spot = placeLogo({ geom, pad: BAR, aspect: 3 });
    expect(spot.region).toBe("bottom");
    expect(spot.height).toBeCloseTo(0.12 * 2000 * 0.4, 6); // 96px
    expect(spot.width).toBeCloseTo(spot.height * 3, 6);
    expect(spot.cy).toBeCloseTo(2000 + 240 / 2, 6);
    expect(geom.outW - (spot.cx + spot.width / 2)).toBeCloseTo(0.075 * 2000, 6); // 150px in from the right
  });

  it("moves to the bar's centre, then its left end, when a brand logo sits at the right", () => {
    const geom = outputGeometry({ fullW: 3000, fullH: 2000, pad: BAR });
    const brand = { type: "sticker", x: 2800 / 3000, y: 2120 / 2000, scale: 0.05, naturalWidth: 100, naturalHeight: 100 };
    const right = placeLogo({ geom, pad: BAR, aspect: 3, occupied: layerBoxes([brand], geom, measure) });
    expect(right.cx).toBeCloseTo(1500, 6);
    const text = { type: "text", text: "Canon EOS R5", fontSize: 64, x: 0.5, y: 2120 / 2000 };
    const left = placeLogo({ geom, pad: BAR, aspect: 3, occupied: layerBoxes([brand, text], geom, measure) });
    expect(left.cx - left.width / 2).toBeCloseTo(150, 6);
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
    expect(spot.height).toBeCloseTo(0.06 * 2000, 6);
    expect(geom.left + geom.contentW - (spot.cx + spot.width / 2)).toBeCloseTo(0.075 * 2000, 6);
  });

  it("reads a background's lightness to choose black or white", () => {
    expect(backgroundLightness({ color: "#ffffff" })).toBeCloseTo(1, 6);
    expect(backgroundLightness({ color: "#0c0c0c" })).toBeLessThan(0.1);
    expect(backgroundLightness({ mode: "gradient", gradient: { from: "#000000", to: "#ffffff" } })).toBeCloseTo(0.5, 6);
    expect(backgroundLightness(null)).toBeCloseTo(1, 6); // a margin with no colour set is white
  });
});
