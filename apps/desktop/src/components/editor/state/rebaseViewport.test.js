import { describe, expect, it } from "vitest";
import { BASE_STATE } from "./editorStateModel";
import { rebaseViewport } from "./rebaseViewport";
import { getBasePlacement, getImageRect, getNormalizedCrop } from "../imageMath";

describe("viewport-independent crop history", () => {
  const source = { width: 512, height: 384 };
  const from = { width: 1400, height: 900 };
  const to = { width: 950, height: 600 };
  for (const quarterTurns of [0, 1, 2, 3, -1]) {
    it(`preserves cropped/zoomed photo fractions at quarter turn ${quarterTurns}`, () => {
      const size = Math.abs(quarterTurns % 2) === 1
        ? { width: source.height, height: source.width } : source;
      const placement = getBasePlacement(from, size);
      const state = { ...BASE_STATE, quarterTurns, imageZoom: 1.7, imageOffsetX: 20, imageOffsetY: -30 };
      const rect = getImageRect(state, size, placement);
      state.cropRect = { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.1, width: rect.width * 0.6, height: rect.height * 0.7 };
      const before = getNormalizedCrop(state, rect);
      const next = rebaseViewport(state, source, from, to);
      const after = getNormalizedCrop(next, getImageRect(next, size, getBasePlacement(to, size)));
      for (const key of ["x", "y", "width", "height"]) expect(after[key]).toBeCloseTo(before[key], 12);
      const restored = rebaseViewport(next, source, to, from);
      for (const key of ["x", "y", "width", "height"]) expect(restored.cropRect[key]).toBeCloseTo(state.cropRect[key], 12);
      expect(next.imageZoom).toBe(state.imageZoom);
      expect(next.canvas).toBe(state.canvas);
    });
  }
  it("leaves an uninitialized crop alone", () => {
    expect(rebaseViewport(BASE_STATE, source, from, to)).toBe(BASE_STATE);
  });
});
