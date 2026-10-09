import { describe, expect, it } from "vitest";

import { applyPreset, createDefaultLayer, PRESETS, pickTextStyle, TEXT_STYLE_KEYS } from "./textState";

describe("a text layer's remembered style", () => {
  it("keeps the look and leaves out the content, position and depth", () => {
    const layer = applyPreset(createDefaultLayer({ text: "Hello", x: 0.2, y: 0.8, rotation: 12, zPosition: 0.4 }), PRESETS[0]);
    const style = pickTextStyle(layer);
    expect(style.fontWeight).toBe(PRESETS[0].style.fontWeight);
    expect(style.textCase).toBe("upper");
    for (const key of ["id", "type", "text", "x", "y", "rotation", "zPosition", "preset"]) {
      expect(style).not.toHaveProperty(key);
    }
  });

  it("covers every style field a new layer has", () => {
    const fresh = createDefaultLayer();
    const style = pickTextStyle(fresh);
    for (const key of Object.keys(style)) expect(TEXT_STYLE_KEYS).toContain(key);
    // A new layer built from it looks like the one it came from.
    const copy = createDefaultLayer(style);
    for (const key of Object.keys(style)) expect(copy[key]).toEqual(fresh[key]);
  });

  it("drops values that could not have come from the editor", () => {
    expect(pickTextStyle({
      fontFamily: { evil: true },
      fontSize: -4,
      fillColor: "x".repeat(500),
      strokeWidth: Number.POSITIVE_INFINITY,
      italic: true,
    })).toEqual({ italic: true });
    expect(pickTextStyle(null)).toEqual({});
    expect(pickTextStyle("Inter")).toEqual({});
  });
});
