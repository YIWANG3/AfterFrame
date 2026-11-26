// Greek in frame text. The bundled frame fonts (Outfit and the rest) are Latin
// only, so an α (Sony names its cameras α7C II, α1 II) is drawn by whatever
// font the system finds: thinner, rounder, plainly another face. Outfit's own
// lowercase a is the single-storey kind, the same shape as α, so a camera name
// in a font without α gets that a ("a7C II", the Latin spelling retailers use)
// and stays in one face. A font that has α keeps it.

let ctx = null;
const known = new Map();

/** Does `family` itself draw `ch`, rather than a fallback font? */
export function fontHasGlyph(family, ch) {
  const key = `${family}\u0000${ch}`;
  if (known.has(key)) return known.get(key);
  if (typeof document === "undefined") return true;
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  const width = (font) => {
    ctx.font = `72px ${font}`;
    return ctx.measureText(ch).width;
  };
  // A missing glyph comes from the generic family named after the font: the
  // same width as that family's own, whichever of two unlike families it is.
  const has = ["monospace", "serif"].some((base) => width(`"${family}", ${base}`) !== width(base));
  // A font still loading measures as its fallback: keep only what the loaded
  // font answered.
  if (document.fonts?.check?.(`72px "${family}"`) !== false) known.set(key, has);
  return has;
}

/** `text` to set in `family`: Greek alphas it can't draw become the Latin a. */
export function textForFont(text, family, has = fontHasGlyph) {
  if (!text || !String(text).includes("α")) return text;
  return has(family, "α") ? text : String(text).replace(/α/g, "a");
}
