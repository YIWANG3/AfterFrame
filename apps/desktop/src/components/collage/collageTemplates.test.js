import { describe, expect, it } from "vitest";
import TEMPLATES, { getAllTemplateCounts, getTemplatesForCount } from "./collageTemplates";

// The layout engine tiles the canvas with rectangles and nothing else: every
// template must have exactly `count` cells that cover the canvas once, with
// no overlap. Two templates with the same cells are one template twice (the
// 2026-09-28 review found two of those), so layouts must be unique too.
const cellKey = (cells) => cells
  .map((c) => [c.x, c.y, c.w, c.h].map((v) => v.toFixed(4)).join(","))
  .sort()
  .join("|");

const overlaps = (a, b) => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 1e-6 && oy > 1e-6;
};

describe("collage templates", () => {
  const all = Object.entries(TEMPLATES).flatMap(([count, list]) => list.map((t) => ({ count: Number(count), ...t })));

  it("cover 1 to 12 photos, with several layouts to choose from at every count", () => {
    expect(getAllTemplateCounts()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const count of getAllTemplateCounts()) {
      if (count > 1) expect(TEMPLATES[count].length).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(all)("$id has $count cells that tile the canvas exactly once", ({ count, cells }) => {
    expect(cells).toHaveLength(count);
    const area = cells.reduce((sum, c) => sum + c.w * c.h, 0);
    expect(area).toBeCloseTo(1, 6);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.w).toBeGreaterThan(0);
      expect(c.h).toBeGreaterThan(0);
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) expect(overlaps(cells[i], cells[j])).toBe(false);
    }
  });

  it("has unique ids, each starting with its count, and no two identical layouts", () => {
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of all) expect(t.id.startsWith(`${t.count}-`)).toBe(true);
    const seen = new Map();
    for (const t of all) {
      const key = cellKey(t.cells);
      expect(seen.get(key), `${t.id} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, t.id);
    }
  });

  it("offers the requested layouts the user asked for by name", () => {
    const names = (count) => TEMPLATES[count].map((t) => t.name);
    expect(names(5)).toContain("2 + Wide + 2");
    expect(names(7)).toContain("3 + Wide + 3");
    expect(names(9)).toContain("4+1+4");
    expect(names(6)).toContain("Big + 5");
  });

  it("falls back to the largest smaller group when a count has no templates", () => {
    expect(getTemplatesForCount(13)).toBe(TEMPLATES[12]);
    expect(getTemplatesForCount(0)).toBe(TEMPLATES[2]);
    expect(getTemplatesForCount(7)).toBe(TEMPLATES[7]);
  });
});
