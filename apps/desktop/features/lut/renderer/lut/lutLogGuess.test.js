import { describe, expect, it } from "vitest";
import { guessLogInput } from "../../../../shared/lutLogGuess.mjs";

const guess = (name, extra = {}) => guessLogInput({ name, ...extra });

describe("guessLogInput", () => {
  it("names the curve from real pack and file names", () => {
    expect(guess("Phntm_ARRI_Neutral_G11_Slog3")).toBe("S-Log");
    expect(guess("SLog3SGamut3.CineToLC-709TypeA")).toBe("S-Log");
    expect(guess("Sony S-Log2 to Rec709")).toBe("S-Log");
    expect(guess("Panasonic V-Log")).toBe("V-Log");
    expect(guess("V-Log to V-709")).toBe("V-Log");
    expect(guess("Luna_I-Log_to_Rec709_BT1886_s33_v2")).toBe("I-Log");
    expect(guess("Leica L-Log to Rec.709 Gamma 2.4")).toBe("L-Log");
    expect(guess("The Revenant - Alexa")).toBe("LogC");
    expect(guess("ARRI LogC4 to Rec709")).toBe("LogC");
    expect(guess("The Revenant - REDlogFilm")).toBe("RED Log");
    expect(guess("The Revenant - LOG")).toBe("Log");
    expect(guess("DJI D-Log M to Rec709")).toBe("D-Log");
    expect(guess("Fuji F-Log2 to ETERNA")).toBe("F-Log");
    expect(guess("Canon C-Log3 to 709")).toBe("C-Log");
    expect(guess("Nikon N-Log 3D LUT")).toBe("N-Log");
  });

  it("leaves Rec709 looks alone, and words that merely contain 'log'", () => {
    for (const name of [
      "The Revenant - Rec709", "Kodak Gold200 9", "M02-森系色调", "Teal & Orange 4", "Catalog look",
      "Blog Warm", "Logo Fade", "Prologue", "Vlog-海边人像", "Rec709 to LOG",
    ]) {
      expect(guess(name), name).toBeNull();
    }
  });

  it("reads 'vlog' as V-Log only beside Panasonic's names", () => {
    expect(guess("Panasonic_VLog_to_V709")).toBe("V-Log");
    expect(guess("VLog Daily")).toBeNull();
  });

  it("takes the pack's folders into account, the nearest two only", () => {
    expect(guess("The Revenant", { folders: ["LUTIFY", "LOG"] })).toBe("Log");
    expect(guess("The Revenant", { folders: ["LUTIFY", "STANDARD"] })).toBeNull();
    expect(guess("x", { folders: ["my log files", "Packs", "STANDARD"] })).toBeNull();
  });

  it("reads TITLE, and comments only when they name an input", () => {
    expect(guess("look01", { title: "S-Log3 Cine look" })).toBe("S-Log");
    expect(guess("Kodak 2383", { comments: ["Input: Panasonic V-Log", "Output: Rec709"] })).toBe("V-Log");
    expect(guess("Warm", { comments: ["Not meant for log footage"] })).toBeNull();
  });
});
