import { describe, expect, it } from "vitest";
import { mergeHandwritingPatch, mergeOwnLayers, paintFromFields, paintToFields } from "./textPanelLogic";

describe("paintFromFields / paintToFields", () => {
  it("reads a layer's fill as a paint and writes the paint back to the same fields", () => {
    const layer = {
      fillMode: "gradient", fillColor: "#112233", fillOpacity: 80,
      gradientFrom: "#000000", gradientFromOpacity: 50, gradientTo: "#ffffff", gradientToOpacity: 100, gradientAngle: 45,
    };
    const paint = paintFromFields(layer, "fill");
    expect(paint).toEqual({
      mode: "gradient", color: "#112233", opacity: 0.8,
      gradient: { from: "#000000", fromOpacity: 0.5, to: "#ffffff", toOpacity: 1, angle: 45 },
    });
    expect(paintToFields(paint, "fill")).toEqual(layer);
  });

  it("fills in defaults for a layer that never had a gradient", () => {
    expect(paintFromFields({ fillColor: "#abcdef" }, "fill")).toEqual({
      mode: "solid", color: "#abcdef", opacity: 1,
      gradient: { from: "#ffffff", fromOpacity: 1, to: "#d2a05a", toOpacity: 1, angle: 90 },
    });
    expect(paintFromFields({ strokeColor: "#123456" }, "stroke").gradient.from).toBe("#123456");
    expect(paintFromFields({ bgColor: "#654321" }, "bg").gradient.from).toBe("#654321");
  });

  it("writes only the fields a patch carries", () => {
    expect(paintToFields({ color: "#ff0000" }, "stroke")).toEqual({ strokeColor: "#ff0000" });
    expect(paintToFields({ opacity: 0.25, gradient: { angle: 10 } }, "bg")).toEqual({ bgOpacity: 25, bgGradAngle: 10 });
    expect(paintToFields({ opacity: 0.5 }, "stroke")).toEqual({});
  });

  it("knows no other paint kind", () => {
    expect(paintFromFields({}, "glow")).toBeNull();
    expect(paintToFields({ color: "#fff" }, "glow")).toEqual({});
  });
});

describe("mergeHandwritingPatch", () => {
  it("merges a later patch over an earlier one, gradients field by field", () => {
    const merged = mergeHandwritingPatch({ color: "#111111", gradient: { from: "#000000", angle: 90 } }, { gradient: { to: "#ffffff" } });
    expect(merged).toEqual({ color: "#111111", gradient: { from: "#000000", angle: 90, to: "#ffffff" } });
  });
  it("starts from nothing", () => {
    expect(mergeHandwritingPatch(null, { mode: "solid" })).toEqual({ mode: "solid" });
  });
});

describe("mergeOwnLayers", () => {
  const text = (id) => ({ id, type: "text" });
  const frame = (id) => ({ id, type: "text", fromPreset: true });
  it("puts a tool's reordered layers back into the slots that tool's layers held", () => {
    const all = [text("a"), frame("f1"), text("b"), frame("f2"), text("c")];
    const next = mergeOwnLayers(all, [text("c"), text("a"), text("b")], false);
    expect(next.map((l) => l.id)).toEqual(["c", "f1", "a", "f2", "b"]);
  });
  it("drops a layer the tool took out, keeping the other tool's", () => {
    const all = [text("a"), frame("f1"), text("b")];
    expect(mergeOwnLayers(all, [frame("f1")], true).map((l) => l.id)).toEqual(["a", "f1", "b"]);
    expect(mergeOwnLayers(all, [text("b")], false).map((l) => l.id)).toEqual(["f1", "b"]);
  });
});
