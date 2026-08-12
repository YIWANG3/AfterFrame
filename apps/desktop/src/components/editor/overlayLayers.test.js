import { describe, expect, it } from "vitest";
import { createOverlayLayer } from "./textState";
import { isOverlayLayer, layerLabel, moveLayerBy } from "./layerStack";
import { bakeLayersIntoCrop, layersToDisplay } from "./imageMath";

describe("overlay layers", () => {
  it("creates independent, reorderable layer-stack items", () => {
    const first = createOverlayLayer();
    const second = createOverlayLayer({ mode: "solid", color: "#123456" });

    expect(first.id).not.toBe(second.id);
    expect(isOverlayLayer(first)).toBe(true);
    expect(layerLabel(first)).toBe("Overlay");
    expect(moveLayerBy([first, second], first.id, 1).map((layer) => layer.id))
      .toEqual([second.id, first.id]);
  });

  it("stays full-photo scoped across crop, padding and Apply rebasing", () => {
    const overlay = createOverlayLayer();
    const preview = { width: 1600, height: 900 };
    const crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.75 };
    const pad = { top: 0.1, right: 0.2, bottom: 0.15, left: 0.05 };

    expect(layersToDisplay([overlay], preview, crop, pad)).toEqual([overlay]);
    expect(bakeLayersIntoCrop([overlay], preview, crop, pad)).toEqual([overlay]);
  });
});
