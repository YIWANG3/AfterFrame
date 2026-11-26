import { describe, expect, it } from "vitest";
import { fontHasGlyph, textForFont } from "./frameGlyphs";

describe("Greek in frame text", () => {
  const latinOnly = () => false;
  const greek = () => true;

  it("gives a camera name's α the font's own a when it has no α", () => {
    expect(textForFont("α7C II", "Outfit", latinOnly)).toBe("a7C II");
    expect(textForFont("Sony α1 II · α", "Outfit", latinOnly)).toBe("Sony a1 II · a");
  });

  it("keeps α in a font that draws it, and text without one as it is", () => {
    expect(textForFont("α7C II", "Inter", greek)).toBe("α7C II");
    expect(textForFont("EOS R6 Mark II", "Outfit", latinOnly)).toBe("EOS R6 Mark II");
    expect(textForFont("", "Outfit", latinOnly)).toBe("");
    expect(textForFont(null, "Outfit", latinOnly)).toBe(null);
  });

  it("assumes a font draws everything where it can't measure", () => {
    expect(fontHasGlyph("Outfit", "α")).toBe(true);
  });
});
