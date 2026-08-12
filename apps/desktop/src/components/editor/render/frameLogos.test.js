import { describe, expect, it } from "vitest";
import {
  brandIdForExif,
  buildLogoRegistry,
  pickVariant,
  recolorSvgColors,
} from "./frameLogos";

const manifest = {
  logos: [{
    id: "insta360",
    variants: [
      { id: "wordmark", kind: "wordmark", file: "insta360/wordmark.svg" },
      { id: "luna-ultra", kind: "wordmark", models: ["luna ultra"], file: "insta360/luna.svg" },
    ],
  }],
  match: { insta360: "insta360", "arashi vision": "insta360" },
};

describe("frame logo selection", () => {
  const registry = buildLogoRegistry(manifest);
  const brand = registry.byId.get("insta360");

  it("matches Insta360's EXIF manufacturer name", () => {
    expect(brandIdForExif({ make: "Arashi Vision Inc.", camera_model: "Luna Ultra" }, registry)).toBe("insta360");
  });

  it("also checks Model when Make is unrecognized", () => {
    expect(brandIdForExif({ make: "Unknown", camera_model: "Insta360 X5" }, registry)).toBe("insta360");
  });

  it("uses the product-specific Luna Ultra mark", () => {
    expect(pickVariant(brand, { variantId: "wordmark", model: "Insta360 Luna Ultra" })?.id).toBe("luna-ultra");
    expect(pickVariant(brand, { variantId: "symbol", model: "Insta360 Luna Ultra" })?.id).toBe("luna-ultra");
  });

  it("falls back to the general mark for other product lines", () => {
    expect(pickVariant(brand, { variantId: "wordmark", model: "Insta360 X5" })?.id).toBe("wordmark");
  });

  it("preserves strict variant slots in dual-logo templates", () => {
    expect(pickVariant(brand, { variantId: "symbol", strict: true, model: "Insta360 Luna Ultra" })).toBeNull();
  });
});

describe("partial logo tinting", () => {
  it("recolors text while preserving a spot-color badge", () => {
    const svg = '<svg color="#FEFEFE"><path fill="currentColor"/><g color="#FFFFFF"><path fill="currentColor"/></g><path fill="#E2001A"/></svg>';
    expect(recolorSvgColors(svg, ["#FEFEFE"], "#141414"))
      .toBe('<svg color="#141414"><path fill="currentColor"/><g color="#FFFFFF"><path fill="currentColor"/></g><path fill="#E2001A"/></svg>');
  });
});
