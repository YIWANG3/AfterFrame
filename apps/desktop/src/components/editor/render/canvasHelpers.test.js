import { describe, expect, it } from "vitest";
import {
  gradientColorAt, gradientStops, gradientToCss, gradientWithStops,
  normalizeScrim, parseCssColor, scrimCoverageRect, scrimToCss,
} from "./canvasHelpers";
import { createOverlayLayer } from "../textState";

describe("parseCssColor", () => {
  it("reads rgba() strings into hex + alpha", () => {
    expect(parseCssColor("rgba(0,0,0,0.5)")).toEqual({ hex: "#000000", opacity: 0.5 });
    expect(parseCssColor("rgb(255, 128, 0)", 0.3)).toEqual({ hex: "#ff8000", opacity: 0.3 });
  });
  it("reads hex forms", () => {
    expect(parseCssColor("#ABC")).toEqual({ hex: "#aabbcc", opacity: 1 });
    expect(parseCssColor("#11223380").opacity).toBeCloseTo(128 / 255);
  });
});

describe("gradient stops", () => {
  it("derives two stops from the legacy from/to shape", () => {
    expect(gradientStops({ from: "#111111", fromOpacity: 0.2, to: "#222222", toOpacity: 0.8 })).toEqual([
      { pos: 0, color: "#111111", opacity: 0.2 },
      { pos: 1, color: "#222222", opacity: 0.8 },
    ]);
  });
  it("prefers explicit stops, sorted by position", () => {
    const g = { from: "#ffffff", to: "#000000", stops: [
      { pos: 1, color: "#000000", opacity: 1 },
      { pos: 0.5, color: "#ff0000", opacity: 0.5 },
      { pos: 0, color: "#ffffff", opacity: 0 },
    ] };
    expect(gradientStops(g).map((s) => s.pos)).toEqual([0, 0.5, 1]);
    expect(gradientToCss({ ...g, angle: 90 })).toBe(
      "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,0,0,0.5) 50%, rgba(0,0,0,1) 100%)",
    );
  });
  it("keeps from/to in sync with the outer stops", () => {
    const g = gradientWithStops({ angle: 45 }, [
      { pos: 0.7, color: "#333333", opacity: 0.3 },
      { pos: 0.1, color: "#aaaaaa", opacity: 1 },
    ]);
    expect(g.from).toBe("#aaaaaa");
    expect(g.to).toBe("#333333");
    expect(g.toOpacity).toBe(0.3);
    expect(g.angle).toBe(45);
  });
  it("interpolates a new stop's color from its neighbours", () => {
    const stops = [{ pos: 0, color: "#000000", opacity: 0 }, { pos: 1, color: "#ffffff", opacity: 1 }];
    const mid = gradientColorAt(stops, 0.5);
    expect(mid.color).toBe("#808080");
    expect(mid.opacity).toBeCloseTo(0.5);
  });
});

describe("overlay / scrim model", () => {
  it("converts a frame-template edge scrim into the unified overlay shape", () => {
    const s = normalizeScrim({ edge: "top", from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.5)", height: 0.3 });
    expect(s.edge).toBe("top");
    expect(s.coverage).toBe(0.3);
    expect(s.mode).toBe("gradient");
    // stops run inner → edge; for a top band that is angle 0 (upwards)
    expect(s.gradient.angle).toBe(0);
    expect(s.gradient.stops).toEqual([
      { pos: 0, color: "#000000", opacity: 0 },
      { pos: 1, color: "#000000", opacity: 0.5 },
    ]);
  });
  it("defaults a bare overlay to a full-photo bottom-up wash", () => {
    const s = normalizeScrim({});
    expect(s.coverage).toBe(1);
    expect(s.edge).toBe("bottom");
    expect(s.gradient.angle).toBe(180);
    expect(s.gradient.stops.map((x) => x.opacity)).toEqual([0, 0.7]);
  });
  it("computes the covered sub-rect from edge + coverage", () => {
    const rect = { x: 10, y: 20, width: 200, height: 100 };
    expect(scrimCoverageRect({ edge: "bottom", coverage: 0.25 }, rect)).toEqual({ x: 10, y: 95, width: 200, height: 25 });
    expect(scrimCoverageRect({ edge: "top", coverage: 0.5 }, rect)).toEqual({ x: 10, y: 20, width: 200, height: 50 });
    expect(scrimCoverageRect({ edge: "left", coverage: 0.1 }, rect)).toEqual({ x: 10, y: 20, width: 20, height: 100 });
    expect(scrimCoverageRect({ edge: "right", coverage: 0.5 }, rect)).toEqual({ x: 110, y: 20, width: 100, height: 100 });
    expect(scrimCoverageRect({ coverage: 1 }, rect)).toEqual(rect);
  });
  it("renders the same CSS for a template scrim and its layer form", () => {
    const tpl = { edge: "bottom", from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.5)", height: 0.32 };
    const layer = createOverlayLayer({ ...tpl, fromPreset: true });
    expect(layer.type).toBe("overlay");
    expect(layer.fromPreset).toBe(true);
    expect(layer.kind).toBeUndefined();
    expect(layer.coverage).toBe(0.32);
    expect(scrimToCss(layer)).toBe(scrimToCss(tpl));
    expect(scrimToCss(layer)).toBe("linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 100%)");
  });
  it("createOverlayLayer keeps explicit multi-stop gradients and coverage", () => {
    const layer = createOverlayLayer({
      mode: "gradient", edge: "left", coverage: 0.4,
      gradient: { angle: 90, stops: [
        { pos: 0, color: "#000000", opacity: 0.8 }, { pos: 0.5, color: "#000000", opacity: 0.2 }, { pos: 1, color: "#000000", opacity: 0 },
      ] },
    });
    expect(layer.edge).toBe("left");
    expect(layer.coverage).toBe(0.4);
    expect(layer.gradient.stops).toHaveLength(3);
    expect(layer.gradient.from).toBe("#000000");
    expect(layer.gradient.fromOpacity).toBe(0.8);
  });
});
