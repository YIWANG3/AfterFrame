// Is this LUT meant for Log footage? (docs/lut-plan.md §7)
//
// A Log LUT expects a flat camera-log picture; put on a normal photo it
// crushes the shadows and oversaturates. About a third of real LUT packs are
// Log ones (LUTIFY ships every look as Rec709 / LOG / Alexa / REDlogFilm), and
// nothing in a .cube says so, so the name is the evidence: the file name, the
// folders it sits in, the TITLE, and comments that name an input. The user can
// overrule the guess per LUT.
//
// "S-Log3 to Rec709" is a Log LUT (its INPUT is S-Log3), so the output side —
// whatever follows "to" — is cut off before matching. "Vlog" alone is not:
// Chinese packs use it for video-blog looks ("Vlog-海边人像"); Panasonic's
// curve is written "V-Log".

const OUTPUT_SIDE = [
  // "slog3 to rec709", "logc_to_709", "s-log3 2 709", "slog3 -> 709"
  /(?:^|[\s_-])(?:to|2|->|→)(?:[\s_-]|$)/,
  // camelCase joins once lower-cased: "slog3sgamut3.cinetolc-709"
  /to(?=[\s_-]?(?:rec|709|lc-?709|bt|srgb|cine\+?709|2383|2393|2395|kodak|fuji|film|video|hlg|pq|st2084|v709))/,
];

function inputSide(text) {
  let s = text;
  for (const re of OUTPUT_SIDE) {
    const m = re.exec(s);
    if (m && m.index > 0) s = s.slice(0, m.index);
  }
  return s;
}

// Order matters: specific curves before the bare word "log".
const CURVES = [
  ["S-Log", /(?<![a-z])s-?log(?:[23]|(?![a-z]))/],
  ["F-Log", /(?<![a-z])f-?log(?:2|(?![a-z]))/],
  ["V-Log", /(?<![a-z])v-log(?![a-z])/],
  ["C-Log", /(?<![a-z])c-?log(?:[23]|(?![a-z]))/],
  ["D-Log", /(?<![a-z])d-?log(?:(?![a-z])|m(?![a-z]))/],
  ["N-Log", /(?<![a-z])n-?log(?![a-z])/],
  ["L-Log", /(?<![a-z])l-?log(?![a-z])/],
  ["I-Log", /(?<![a-z])i-?log(?![a-z])/],
  ["H-Log", /(?<![a-z])h-?log(?![a-z])/],
  ["LogC", /(?<![a-z])log-?c[34]?(?![a-z])|(?<![a-z])alexa(?![a-z])/],
  ["RED Log", /redlog(?:film)?|log3g10/],
  ["BMD Film", /(?<![a-z])bmd[\s_-]?film|blackmagic[\s_-]?film/],
  ["Cineon", /(?<![a-z])cineon(?![a-z])/],
  ["Log", /(?<![a-z])log(?![a-z])/],
];

// "vlog" with Panasonic context is V-Log after all ("Panasonic_VLog_to_V709").
const PANASONIC = /panasonic|lumix|v-?gamut|v709|varicam/;

function matchCurve(text) {
  const s = inputSide(text.toLowerCase().replace(/[_.]+/g, " "));
  for (const [kind, re] of CURVES) if (re.test(s)) return kind;
  if (/(?<![a-z])vlog(?![a-z])/.test(s) && PANASONIC.test(text.toLowerCase())) return "V-Log";
  return null;
}

/**
 * @param {{ name: string, folders?: string[], title?: string, comments?: string[] }} lut
 *   `name` without extension; `folders` from the library root, outermost first.
 * @returns {string|null} the Log curve it expects ("S-Log", "LogC", … or "Log"
 *   when only the word is there), null for a normal (Rec709) LUT
 */
export function guessLogInput({ name = "", folders = [], title = "", comments = [] }) {
  const candidates = [
    name,
    // The pack's own folders ("LUTIFY…/LOG/x.cube"); only the nearest two, so
    // a library folder someone named "my logs" far up doesn't mark everything.
    ...folders.slice(-2),
    title,
    // Only comments that state an input ("Input: Panasonic V-Log"); prose like
    // "not for log footage" would otherwise mark a Rec709 LUT.
    ...comments.filter((c) => /\binput\b/i.test(c)),
  ];
  for (const text of candidates) {
    if (!text) continue;
    const kind = matchCurve(String(text));
    if (kind) return kind;
  }
  return null;
}
