import { describe, expect, it } from "vitest";

import {
  createDefaultSplitRect,
  fitSplitRect,
  moveSplitRect,
  panelBoundaries,
  reshapeSplitRect,
  resizeSplitRect,
  resolveSplitCount,
  splitRectToPanels,
  normalizeSplitRect,
  denormalizeSplitRect,
} from "./splitMath";

const bounds = { x: 100, y: 50, width: 1200, height: 400 };

describe("splitMath", () => {
  it("picks as many panels as fit across the photo, clamped to 2..10", () => {
    expect(resolveSplitCount(3000, 1000, 3 / 4, null)).toBe(4);
    expect(resolveSplitCount(1000, 1000, 3 / 4, null)).toBe(2);
    expect(resolveSplitCount(30000, 1000, 3 / 4, null)).toBe(10);
    expect(resolveSplitCount(3000, 1000, 3 / 4, 7)).toBe(7);
    expect(resolveSplitCount(3000, 1000, 3 / 4, 99)).toBe(10);
  });

  it("defaults to a full-height, centred region", () => {
    const rect = createDefaultSplitRect(bounds, 3 * (3 / 4));
    expect(rect.height).toBeCloseTo(400);
    expect(rect.width).toBeCloseTo(900);
    expect(rect.x).toBeCloseTo(100 + 150);
    expect(rect.y).toBeCloseTo(50);
  });

  it("lets the width win when the region would be wider than the photo", () => {
    const rect = createDefaultSplitRect(bounds, 10 * (3 / 4));
    expect(rect.width).toBeCloseTo(1200);
    expect(rect.height).toBeCloseTo(160);
    expect(rect.y).toBeCloseTo(50 + 120);
  });

  it("keeps the centre and height when the aspect changes", () => {
    const rect = { x: 400, y: 100, width: 300, height: 300 };
    const next = reshapeSplitRect(rect, bounds, 2);
    expect(next.height).toBeCloseTo(300);
    expect(next.width).toBeCloseTo(600);
    expect(next.x + next.width / 2).toBeCloseTo(550);
    expect(next.y + next.height / 2).toBeCloseTo(250);
  });

  it("clamps moves to the photo", () => {
    const rect = { x: 200, y: 100, width: 300, height: 200 };
    const moved = moveSplitRect(rect, bounds, -5000, 5000);
    expect(moved.x).toBeCloseTo(100);
    expect(moved.y).toBeCloseTo(50 + 400 - 200);
    expect(moved.width).toBeCloseTo(300);
  });

  it("shrinks a region whose rotated extent no longer fits", () => {
    const rect = { x: 100, y: 50, width: 1200, height: 400 };
    const fitted = fitSplitRect(rect, bounds, 10);
    expect(fitted.width).toBeLessThan(1200);
    expect(fitted.width / fitted.height).toBeCloseTo(3);
    expect(fitted.x).toBeGreaterThanOrEqual(100 - 1e-6);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(1300 + 1e-6);
  });

  it("resizes from a corner with the aspect locked and stays inside the photo", () => {
    const rect = { x: 400, y: 100, width: 300, height: 100 };
    const grown = resizeSplitRect(rect, "se", { x: 1500, y: 900 }, bounds, 3);
    expect(grown.x).toBeCloseTo(400);
    expect(grown.y).toBeCloseTo(100);
    expect(grown.width / grown.height).toBeCloseTo(3);
    expect(grown.x + grown.width).toBeLessThanOrEqual(1300 + 1e-6);
    expect(grown.y + grown.height).toBeLessThanOrEqual(450 + 1e-6);
  });

  it("round-trips normalized rects", () => {
    const rect = { x: 400, y: 150, width: 300, height: 100 };
    const n = normalizeSplitRect(rect, bounds);
    expect(n).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 });
    expect(denormalizeSplitRect(n, bounds)).toEqual(rect);
  });

  it("produces contiguous panels that exactly tile the region", () => {
    const b = panelBoundaries(1001, 3);
    expect(b).toEqual([0, 334, 667, 1001]);
    const panels = splitRectToPanels({ x: 0.1, y: 0, width: 0.8, height: 1 }, 3, 4001, 1500);
    expect(panels).toHaveLength(3);
    for (let i = 1; i < panels.length; i++) {
      expect(panels[i].x).toBe(panels[i - 1].x + panels[i - 1].width);
      expect(panels[i].height).toBe(panels[0].height);
    }
    const total = panels.reduce((sum, p) => sum + p.width, 0);
    expect(total).toBe(Math.round(0.8 * 4001));
    const widths = panels.map((p) => p.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});
