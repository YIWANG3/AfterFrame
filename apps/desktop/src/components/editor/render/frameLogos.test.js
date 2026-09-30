import { describe, expect, it } from "vitest";
import {
  brandIdForExif,
  brandKeyForExif,
  buildLogoRegistry,
  builtInMarks,
  cameraNamer,
  cameraNamesFor,
  labelExif,
  modelDisplayName,
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

describe("what a camera is called", () => {
  const registry = buildLogoRegistry({
    logos: [
      { id: "canon", name: "Canon", variants: [] }, { id: "nikon", name: "Nikon", variants: [] },
      { id: "dji", name: "DJI", variants: [{ id: "wordmark", kind: "wordmark", file: "d.svg" }] },
    ],
    match: { canon: "canon", nikon: "nikon", dji: "dji" },
  });

  it("rules: Canon's m2, Nikon's _2, Sony's ILCE codes; anything else as EXIF writes it", () => {
    expect(modelDisplayName("canon", "Canon EOS R6m2")).toBe("Canon EOS R6 Mark II");
    expect(modelDisplayName("canon", "Canon EOS R5m2")).toBe("Canon EOS R5 Mark II");
    expect(modelDisplayName("canon", "Canon EOS R6 Mark III")).toBe("Canon EOS R6 Mark III");
    expect(modelDisplayName("nikon", "NIKON Z5_2")).toBe("Nikon Z5II");
    expect(modelDisplayName("nikon", "NIKON Z 6_3")).toBe("Nikon Z 6III");
    expect(modelDisplayName("nikon", "NIKON Z 8")).toBe("NIKON Z 8");
    expect(modelDisplayName("sony", "ILCE-7CM2")).toBe("Sony α7C II");
    expect(modelDisplayName("sony", "ILCE-7RM6")).toBe("Sony α7R VI");
    expect(modelDisplayName("sony", "ILCE-7M4")).toBe("Sony α7 IV");
    expect(modelDisplayName("sony", "ILCE-7CR")).toBe("Sony α7CR");
    expect(modelDisplayName("sony", "ILCE-6700")).toBe("Sony α6700");
    expect(modelDisplayName("sony", "ILCE-7RM4A")).toBe("ILCE-7RM4A"); // no rule fits: as written
    expect(modelDisplayName("hasselblad", "CFV 100C/907X")).toBe("CFV 100C/907X");
  });

  it("the name tables come before the rules; manual.json before generated.json; the user before both", () => {
    const tables = {
      generated: { names: { "nikon corporation": { "nikon z5_2": "Nikon Z5 II (gen)" }, dji: { fc9113: "DJI Air 3S", fc9184: "DJI Air 3S" }, sony: { "ilce-7cm2": "Sony α7C II" } } },
      manual: { names: { dji: { fc9113: "DJI Air 3S" }, "nikon corporation": { "nikon z5_2": "Nikon Z5II" } }, brands: { "make:yingling innovations pte. ltd.": "Antigravity" } },
    };
    const namer = cameraNamer(registry, { "dji#fc8282": "My Air 3" }, tables);
    expect(cameraNamesFor({ make: "NIKON CORPORATION", camera_model: "NIKON Z5_2" }, registry, namer).modelName).toBe("Nikon Z5II"); // manual
    expect(cameraNamesFor({ make: "DJI", camera_model: "FC9184" }, registry, namer).modelName).toBe("DJI Air 3S"); // generated
    expect(cameraNamesFor({ make: "DJI", camera_model: "FC8282" }, registry, namer).modelName).toBe("My Air 3"); // the user
    expect(cameraNamesFor({ make: "Canon", camera_model: "Canon EOS R6m2" }, registry, namer).modelName).toBe("Canon EOS R6 Mark II"); // the rule
    expect(cameraNamesFor({ make: "Yingling Innovations Pte. Ltd.", camera_model: "antigravity a1" }, registry, namer).brandName).toBe("Antigravity");
    // A table's name reaches the brand's other make spellings.
    expect(cameraNamesFor({ make: "NIKON", camera_model: "NIKON Z5_2" }, registry, namer).modelName).toBe("Nikon Z5II");
  });

  it("the user's names win, for a model and for a brand with no built-in logo", () => {
    expect(cameraNamesFor({ make: "Canon", camera_model: "Canon EOS R6m2" }, registry)).toEqual({
      brandKey: "canon", modelKey: "canon#canon eos r6m2", brandName: "Canon", modelName: "Canon EOS R6 Mark II",
    });
    const names = { "dji#fc9184": "Air 3S", "make:yingling innovations pte. ltd.": "影翎" };
    expect(cameraNamesFor({ make: "DJI", camera_model: "FC9184" }, registry, names).modelName).toBe("Air 3S");
    expect(cameraNamesFor({ make: "Yingling Innovations Pte. Ltd.", camera_model: "antigravity a1" }, registry, names))
      .toMatchObject({ brandName: "影翎", modelName: "antigravity a1" });
    expect(cameraNamesFor({ make: "", camera_model: "" }, registry)).toBeNull();
    // Frame text reads the display name; matching still reads EXIF.
    expect(labelExif({ make: "DJI", camera_model: "FC9184" }, registry, names)).toMatchObject({ camera_model: "FC9184", camera_label: "Air 3S" });
  });

  it("models the tables name the same are one camera too: a drone's lenses share its logo", () => {
    const mine = [{ id: "logo_air", width: 400, height: 100, tintable: true }];
    const tables = { generated: { names: { dji: { fc9113: "DJI Air 3S", fc9184: "DJI Air 3S", fc8282: "DJI Air 3" } } } };
    const namer = cameraNamer(registry, {}, tables);
    expect(namer.sameCamera("dji", "FC9113").sort()).toEqual(["fc9113", "fc9184"]);
    const reg = withBrandLogos(registry, { "dji#fc9113": "logo_air" }, mine, namer);
    const brand = reg.byId.get("dji");
    expect(pickVariant(brand, { variantId: "wordmark", model: "FC9184" })?.personal).toBe("logo_air");
    expect(pickVariant(brand, { variantId: "wordmark", model: "FC8282" })?.id).toBe("wordmark"); // the Air 3: not the same camera
  });

  it("models named the same are one camera: a model logo set on one reaches the other", () => {
    const mine = [{ id: "logo_air", width: 400, height: 100, tintable: true }];
    const names = { "dji#fc9113": "Air 3S", "dji#fc9184": "air 3s", "dji#fc2204": "Mini 2" };
    const reg = withBrandLogos(registry, { "dji#fc9184": "logo_air" }, mine, names);
    const brand = reg.byId.get("dji");
    expect(pickVariant(brand, { variantId: "wordmark", model: "FC9184" })?.personal).toBe("logo_air");
    expect(pickVariant(brand, { variantId: "wordmark", model: "FC9113" })?.personal).toBe("logo_air"); // the other lens
    expect(pickVariant(brand, { variantId: "wordmark", model: "FC2204" })?.id).toBe("wordmark"); // another drone
  });
});

