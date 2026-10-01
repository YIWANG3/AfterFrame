// The camera naming rules, for models whose EXIF is a code with a pattern:
// Canon "R6m2" -> "R6 Mark II", Nikon "Z5_2" -> "Z5II", Sony "ILCE-7CM2" ->
// "α7C II". The app names cameras with them (frameLogos.cameraNamer), ahead
// of the generated name table, and the table's build leaves out what they
// name (scripts/camera-names). Pure: no DOM, no Node.

const ROMAN = { 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII", 9: "IX" };

/** A model as its brand's rule names it, else as written. */
export function modelDisplayName(brandId, model) {
  const m = String(model || "").trim();
  if (brandId === "canon") return m.replace(/(\w)m([2-9])$/, (_, c, n) => `${c} Mark ${ROMAN[n]}`);
  if (brandId === "nikon") {
    const gen = /^(?:nikon\s+)?(.*?)_([2-9])$/i.exec(m);
    if (gen) return `Nikon ${gen[1]}${ROMAN[gen[2]]}`;
  }
  if (brandId === "sony") {
    const alpha = /^ilce-(\d+)([a-z]*?)(?:m([2-9]))?$/i.exec(m);
    if (alpha) return `Sony α${alpha[1]}${alpha[2].toUpperCase()}${alpha[3] ? ` ${ROMAN[alpha[3]]}` : ""}`;
  }
  return m;
}
