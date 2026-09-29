import { describe, expect, it } from "vitest";
import {
  brandIdForExif,
  brandKeyForExif,
  buildLogoRegistry,
  builtInMarks,
  logoHeightFactor,
  modelKeyFor,
  pickVariant,
  recolorSvgColors,
  withBrandLogos,
} from "./frameLogos";
import { collectLogoNeeds } from "./frameRender";

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

  it("lists every mark a camera shows, a model's own in place of the general one", () => {
    expect(builtInMarks(brand, "Insta360 X5").map((v) => v.id)).toEqual(["wordmark"]);
    expect(builtInMarks(brand, "Luna Ultra").map((v) => v.id)).toEqual(["luna-ultra"]);
    const sony = { variants: [{ id: "symbol", kind: "symbol" }, { id: "wordmark", kind: "wordmark" }] };
    expect(builtInMarks(sony, "ILCE-7CM2").map((v) => v.id)).toEqual(["symbol", "wordmark"]);
    expect(builtInMarks(null, "x")).toEqual([]);
  });

  it("preserves strict variant slots in dual-logo templates", () => {
    expect(pickVariant(brand, { variantId: "symbol", strict: true, model: "Insta360 Luna Ultra" })).toBeNull();
  });
});

describe("a brand's logo chosen by the user", () => {
  const base = buildLogoRegistry({
    logos: [
      ...manifest.logos,
      { id: "hasselblad", variants: [{ id: "symbol", kind: "symbol", h: 1, file: "h/s.svg" }, { id: "wordmark", kind: "wordmark", h: 0.45, file: "h/w.svg" }] },
    ],
    match: { ...manifest.match, hasselblad: "hasselblad" },
  });
  const mine = [
    { id: "logo_wide", width: 1200, height: 300, tintable: true },
    { id: "logo_round", width: 600, height: 600, tintable: false },
  ];
  const antigravity = { make: "Yingling Innovations Pte. Ltd.", camera_model: "antigravity a1" };

  it("is kept under the built-in brand's id, or the make for a camera with none", () => {
    expect(brandKeyForExif({ make: "HASSELBLAD", camera_model: "X2D" }, base)).toBe("hasselblad");
    expect(brandKeyForExif(antigravity, base)).toBe("make:yingling innovations pte. ltd.");
    expect(brandKeyForExif({ make: "  Some   Maker ", camera_model: "" }, base)).toBe("make:some maker");
    expect(brandKeyForExif({ make: "", camera_model: "" }, base)).toBeNull();
  });

  it("replaces every mark of a built-in brand, except a dual template's symbol", () => {
    const registry = withBrandLogos(base, { hasselblad: "logo_wide" }, mine);
    const brand = registry.byId.get(brandIdForExif({ make: "Hasselblad" }, registry));
    expect(pickVariant(brand, { variantId: "wordmark" })).toMatchObject({ id: "mine:logo_wide", personal: "logo_wide" });
    expect(pickVariant(brand, { variantId: "symbol" })?.id).toBe("mine:logo_wide");
    expect(pickVariant(brand, { variantId: "wordmark", strict: true })?.id).toBe("mine:logo_wide");
    expect(pickVariant(brand, { variantId: "symbol", strict: true })).toBeNull();
    // The built-in registry is left as it was: clearing the choice brings the marks back.
    expect(pickVariant(base.byId.get("hasselblad"), { variantId: "symbol" })?.id).toBe("symbol");
  });

  it("gives a camera with no built-in logo a brand of its own", () => {
    expect(brandIdForExif(antigravity, base)).toBeNull();
    const registry = withBrandLogos(base, { "make:yingling innovations pte. ltd.": "logo_round" }, mine);
    const id = brandIdForExif(antigravity, registry);
    expect(id).toBe("make:yingling innovations pte. ltd.");
    expect(brandKeyForExif(antigravity, registry)).toBe(id);
    // Built-in brands still match as before.
    expect(brandIdForExif({ make: "Arashi Vision Inc." }, registry)).toBe("insta360");
  });

  it("one model can have its own logo; the brand's other models keep theirs", () => {
    expect(modelKeyFor("hasselblad", "  X2D  II 100C ")).toBe("hasselblad#x2d ii 100c");
    expect(modelKeyFor("hasselblad", "")).toBeNull();
    const onlyModel = withBrandLogos(base, { "hasselblad#x2d ii 100c": "logo_round" }, mine);
    const brand = onlyModel.byId.get("hasselblad");
    expect(pickVariant(brand, { variantId: "wordmark", model: "X2D II 100C" })?.id).toBe("mine:logo_round:x2d ii 100c");
    expect(pickVariant(brand, { variantId: "wordmark", model: "CFV 100C/907X" })?.id).toBe("wordmark");
    // The model's choice comes before the brand's; the brand's covers the rest.
    const both = withBrandLogos(base, { hasselblad: "logo_wide", "hasselblad#x2d ii 100c": "logo_round" }, mine);
    expect(pickVariant(both.byId.get("hasselblad"), { variantId: "wordmark", model: "X2D II 100C" })?.personal).toBe("logo_round");
    expect(pickVariant(both.byId.get("hasselblad"), { variantId: "wordmark", model: "CFV 100C/907X" })?.personal).toBe("logo_wide");
    // A camera with no built-in logo: only the model given one has any.
    const unknown = withBrandLogos(base, { "make:yingling innovations pte. ltd.#antigravity a1": "logo_round" }, mine);
    const id = brandIdForExif(antigravity, unknown);
    expect(pickVariant(unknown.byId.get(id), { variantId: "wordmark", model: "antigravity a1" })?.personal).toBe("logo_round");
    expect(pickVariant(unknown.byId.get(id), { variantId: "wordmark", model: "antigravity a2" })).toBeNull();
  });

  it("a choice whose logo was deleted changes nothing", () => {
    const registry = withBrandLogos(base, { hasselblad: "logo_gone", "make:x": "logo_gone" }, mine);
    expect(registry.byId.get("hasselblad").mine).toBeUndefined();
    expect(registry.byId.has("make:x")).toBe(false);
  });

  it("is sized and coloured like a built-in mark of its shape", () => {
    expect(logoHeightFactor(4)).toBeCloseTo(0.45, 6); // a wordmark
    expect(logoHeightFactor(1)).toBeCloseTo(0.85, 6); // a square symbol
    const registry = withBrandLogos(base, { hasselblad: "logo_wide", insta360: "logo_round" }, mine);
    const exif = { make: "Hasselblad", camera_model: "X2D" };
    const [need] = collectLogoNeeds({ elements: [{ type: "logo", variant: "wordmark", color: "#ffffff", style: { size: 0.1 } }] }, exif, registry, { outH: 1000 });
    expect(need).toMatchObject({ personal: "logo_wide", color: "#ffffff", colorLocked: false });
    expect(need.key).toContain("logo_wide");
    // A multi-colour logo keeps its colours.
    const [locked] = collectLogoNeeds({ elements: [{ type: "logo", variant: "wordmark", color: "#ffffff" }] }, { make: "Insta360" }, registry, { outH: 1000 });
    expect(locked).toMatchObject({ personal: "logo_round", colorLocked: true });
  });
});

describe("partial logo tinting", () => {
  it("recolors text while preserving a spot-color badge", () => {
    const svg = '<svg color="#FEFEFE"><path fill="currentColor"/><g color="#FFFFFF"><path fill="currentColor"/></g><path fill="#E2001A"/></svg>';
    expect(recolorSvgColors(svg, ["#FEFEFE"], "#141414"))
      .toBe('<svg color="#141414"><path fill="currentColor"/><g color="#FFFFFF"><path fill="currentColor"/></g><path fill="#E2001A"/></svg>');
  });
});
