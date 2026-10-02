// Camera display names from CC0 sources, the pure part: no network, no files.
// build.mjs fetches Wikidata and the Commons "takenwith" catmapping and hands
// them here; out come generated.json's "names" and the keys dropped as
// conflicts. The rules and why: camera-names/README.md.

import { modelDisplayName } from "../../shared/cameraNameRules.mjs";
import { CORRECTIONS } from "./corrections.mjs";

/** A table key: EXIF Make or Model, spaces collapsed, trimmed, lower-cased (the app's normalizeMake). */
export function normKey(x) {
  return String(x ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

const compact = (s) => normKey(s).replace(/\s+/g, "");

// ── Brands ───────────────────────────────────────────────────────────────
// How a brand is spelled at the start of a name ("NIKON Z5II" -> "Nikon Z5II").
// Longer first, so "Sony Ericsson" wins over "Sony".
export const BRANDS = [
  "Konica Minolta", "Sony Ericsson", "Phase One", "OM System",
  "Canon", "Nikon", "Sony", "Fujifilm", "Leica", "Panasonic", "Lumix", "Olympus", "Pentax", "Ricoh",
  "Hasselblad", "DJI", "Insta360", "GoPro", "Sigma", "Kodak", "Casio", "Minolta", "Konica", "Samsung",
  "Epson", "Zeiss", "Mamiya", "Sanyo", "Sharp", "Toshiba", "Kyocera", "Polaroid", "Rollei", "Vivitar",
  "Autel", "Parrot", "Skydio", "Antigravity",
  "Agfa", "Apple", "Google", "Xiaomi", "Huawei", "Motorola", "Nokia", "Lenovo", "HTC", "LG", "ZTE",
  "Honor", "Redmi", "POCO", "OPPO", "OnePlus", "realme", "vivo", "iQOO",
].sort((a, b) => b.length - a.length);

// Makes that do not name their brand.
const MAKE_ALIASES = [
  [/^arashi vision\b/, "Insta360"],
  [/^osmo\b/, "DJI"],
  [/^om digital solutions\b/, "OM System"],
  [/^lge\b/, "LG"],
  [/^fuji\b/, "Fujifilm"],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const brandAt = (brand) => new RegExp(`^${escapeRe(brand)}(?=$|[\\s_/-])`, "i");
const BRAND_AT = BRANDS.map((b) => [b, brandAt(b)]);

/** The brand of an EXIF make key ("nikon corporation" -> "Nikon"), or null. */
export function brandOfMake(makeKey) {
  const make = normKey(makeKey);
  for (const [re, brand] of MAKE_ALIASES) if (re.test(make)) return brand;
  let best = null;
  for (const brand of BRANDS) {
    const m = new RegExp(`(?:^|[\\s,.-])${escapeRe(brand.toLowerCase())}(?=$|[\\s,.-])`).exec(make);
    const at = m ? m.index : -1;
    if (at >= 0 && (!best || at < best.at)) best = { at, brand };
  }
  return best?.brand ?? null;
}

/** The brand at the start of a name spelled the usual way; the rest untouched. */
export function normalizeBrandSpelling(name) {
  // Non-breaking hyphens (Wikidata's "OM\u20111") as plain ones: fonts lack them.
  const s = String(name ?? "").replace(/[\u2010\u2011]/g, "-").replace(/\s+/g, " ").trim();
  for (const [brand, re] of BRAND_AT) if (re.test(s)) return houseStyle(brand + s.slice(brand.length));
  return s;
}

// Sony's A-mount and E-mount bodies are "α" and a number, as the rules name
// them; a sub-brand's phone goes by the sub-brand ("Xiaomi Redmi Note 13" is
// sold as "Redmi Note 13", "vivo iQOO 9 SE" as "iQOO 9 SE"); vivo writes its
// letter suffixes in lower case (V21e, Y15s); realme's narzo before the 70 is
// lower case.
const houseStyle = (s) => {
  let name = s
    .replace(/^Sony Alpha (?=\d)/i, "Sony α")
    .replace(/^Xiaomi (?=(?:Redmi|POCO)\b)/i, "")
    .replace(/^(?:Xiaomi )?Poco(?:phone)?\b/i, "POCO")
    .replace(/^vivo (?=iQOO\b)/i, "")
    .replace(/^realme Narzo (?=(?:[1-6]\d[A-Za-z]?|N\d)\b)/, "realme narzo ");
  if (/^(?:vivo|iQOO) /.test(name)) name = name.replace(/\b([XYVSTUZ]\d{1,3})([SEX])\b/g, (_, code, letter) => code + letter.toLowerCase());
  return name;
};

// ── Which makers ─────────────────────────────────────────────────────────
// Only these makers' devices are named, by the EXIF Make they write now (a
// key, normKey), with the brand: makers still selling cameras, and big
// Chinese phone makers (their EXIF models are codes: "2211133C", "CPH2385").
// Not Huawei and Honor: a review found one in six of their names was another
// market's or a sibling's, the sources filing one phone under one name.
// Everything else is left to its EXIF: other phones, a maker out of cameras
// (Kodak, Casio, Minolta), a Make only old cameras write
// (FUJI PHOTO FILM, OLYMPUS IMAGING CORP., PENTAX Corporation), a model or a
// film typed into Make, a scanner, a microscope.
const CAMERA_MAKES = [
  ["canon", "Canon"],
  ["nikon corporation", "Nikon"], ["nikon", "Nikon"],
  ["sony", "Sony"],
  ["fujifilm", "Fujifilm"],
  ["panasonic", "Panasonic"],
  ["leica camera ag", "Leica"],
  ["om digital solutions", "OM System"], ["olympus corporation", "Olympus"],
  ["ricoh imaging company, ltd.", "Ricoh"],
  ["hasselblad", "Hasselblad"],
  ["sigma", "Sigma"],
  ["phase one", "Phase One"], ["phase one a/s", "Phase One"],
  ["dji", "DJI"], ["osmo", "DJI"],
  ["arashi vision", "Insta360"], ["insta360", "Insta360"],
  ["gopro", "GoPro"],
  ["autel robotics", "Autel"],
  ["parrot", "Parrot"],
  ["skydio", "Skydio"],
  ["yingling innovations pte. ltd.", "Antigravity"],
];
const PHONE_MAKES = [
  ["xiaomi", "Xiaomi"], ["redmi", "Redmi"], ["poco", "POCO"],
  ["oppo", "OPPO"], ["oneplus", "OnePlus"], ["realme", "realme"],
  ["vivo", "vivo"], ["iqoo", "iQOO"],
];
export const MAKES = new Map([...CAMERA_MAKES, ...PHONE_MAKES]);
const PHONE_BRANDS = new Set(PHONE_MAKES.map(([, brand]) => brand));

// Makers whose cameras begin every model with the brand ("Canon EOS R6m2"):
// a model without it was typed by a person.
const MODEL_PREFIX = new Map([["canon", "canon "]]);

// The brands a maker's devices may be named with: its own, a sister brand,
// DJI for the Hasselblad cameras on DJI drones.
const NAMED_AS = {
  Xiaomi: ["Xiaomi", "Redmi", "POCO"],
  Redmi: ["Redmi", "Xiaomi"],
  POCO: ["POCO", "Xiaomi"],
  vivo: ["vivo", "iQOO"],
  iQOO: ["iQOO", "vivo"],
  Panasonic: ["Panasonic", "Lumix"],
  Olympus: ["Olympus", "OM System"],
  "OM System": ["OM System", "Olympus"],
  Ricoh: ["Ricoh", "Pentax"],
  Pentax: ["Pentax", "Ricoh"],
  Hasselblad: ["Hasselblad", "DJI"],
  Autel: ["Autel"],
};

/** Whether a name starts with a brand its maker's cameras go by ("Sony α7 IV" for SONY, not "Huawei Nova" for OLYMPUS). */
export function namedWithItsBrand(makeKey, name) {
  const brand = MAKES.get(normKey(makeKey));
  if (!brand) return false;
  const s = normKey(name);
  return (NAMED_AS[brand] || [brand]).some((b) => s === b.toLowerCase() || s.startsWith(`${b.toLowerCase()} `));
}

// A phone sold under a camera maker's name: Sony's Xperia (and Sony
// Ericsson's), Japanese carriers' Panasonic and Casio handsets, Leica's and
// Kodak's phones.
const PHONE_NAME = /\b(?:xperia|ericsson|softbank|docomo|g'?z ?one|leitz phone|ektra|eluga|phone)\b/i;

// A phone model with something a camera app appended: GCam ports add the
// device's codename ("RMX2050 (RMX2050)") or a profile ("ONEPLUS A6013 P3XL"),
// other apps their own name ("... (Camera Super Pixel)"). Stock firmware
// writes the bare model, which the table has.
const APP_SUFFIX = /\s\([^)]*\)$|\s(?:n6p|n5x|n5|p2xl|p3xl|pxl|p3)$|gcam|shot on|lib google/;

// A name with a market's tag ("Redmi Note 11 (China)", "POCO M4 5G (India)"):
// without it, it can name another phone; left to EXIF.
const MARKET_TAG = /\s\((?:India|Global|China|Europe|International|[A-Z]{2})\)$/;

// An EXIF model no camera writes as it is: in brackets or quotes, one
// person's camera, or a digital back and the body or lens it was on
// ("Ixpress 96 - Hasselblad H1", "GXR MOUNT A12_Summicron-M 35").
const NOT_AN_EXIF_MODEL = /^["[]|["\]]$|\w['’]s\b|\s-\s|_[a-z]/;

// A source name is used as it comes, brand spelling aside: putting a missing
// brand in front goes wrong too often ("Canon HP PhotoSmart R707" for an HP
// camera Canon made, "Panasonic SoftBank Panasonic 301P").

// Not a camera model's name: Commons' catch-alls and one person's camera.
const NOT_A_MODEL = /\b(?:ambiguous|unidentified|unknown)\b|\w['’]s\b/i;

// ── What a name adds ─────────────────────────────────────────────────────
function brandPrefixes(makeKey) {
  const make = normKey(makeKey);
  const set = new Set(BRANDS.map((b) => b.toLowerCase()));
  if (make) set.add(make);
  const first = make.split(" ")[0];
  if (first.length > 1) set.add(first);
  return [...set].sort((a, b) => b.length - a.length);
}

/** Text without the brand words it starts with, normalized ("Panasonic Lumix DMC-GH4" -> "dmc-gh4"). */
export function withoutBrand(makeKey, text) {
  let s = normKey(text);
  const prefixes = brandPrefixes(makeKey);
  for (let i = 0; i < 2; i++) {
    const p = prefixes.find((x) => s === x || s.startsWith(`${x} `) || s.startsWith(`${x}-`) || s.startsWith(`${x}_`));
    if (!p) break;
    s = s.slice(p.length).replace(/^[\s_-]+/, "");
  }
  return s;
}

// Brackets or quotes around a whole EXIF value ("[FC9113]", "\"E-P2\"") are noise.
const unwrap = (s) => s.replace(/^\[(.*)\]$/, "$1").replace(/^"(.*)"$/, "$1").trim();
const core = (makeKey, text) => compact(withoutBrand(makeKey, unwrap(normKey(text))));

/** Whether a name says more than the raw EXIF model, ignoring case, spaces and the brand. */
export function addsInformation(makeKey, model, name) {
  const n = core(makeKey, name);
  return n !== "" && n !== core(makeKey, model);
}

/**
 * Whether a name leaves out a number the EXIF model has: "iPad" for "iPad 4",
 * "Canon EOS 5D" for "Canon EOS 5D Mark II". The name is a family, or the
 * wrong camera.
 */
export function lessSpecific(makeKey, model, name) {
  const n = core(makeKey, name);
  const m = core(makeKey, model);
  return m.length > n.length && m.startsWith(n) && /^(?:\d|mark|mk)/.test(m.slice(n.length));
}

// Makes whose cameras sit on drones and go by codes (DJI FC9113 on the Air 3S).
const DRONE_MAKES = new Set(["dji", "hasselblad", "osmo"]);

const isCode = (s) => !/\s/.test(s) && /^[a-z]*-?\d[a-z\d-]*$/.test(s) && (s.match(/\d/g) || []).length >= 3;

/**
 * Whether the name is a bare camera code for an EXIF model that is a name:
 * Commons files "DJI Mini 3 Pro" under "DJI FC3582". Drone makes only: for
 * other makes a code-like name is usually the product's ("Honor 100").
 */
export function codeForName(makeKey, model, name) {
  if (!DRONE_MAKES.has(normKey(makeKey))) return false;
  const n = withoutBrand(makeKey, name);
  const m = withoutBrand(makeKey, unwrap(normKey(model)));
  const bare = (s) => s.replace(/[\s-]/g, "");
  return isCode(n) && !isCode(m) && !bare(m).includes(bare(n));
}

/**
 * Whether the name lists several models ("Canon HF R10 / R16", "Huawei Honor
 * 6C / Enjoy 6S / Nova Smart") for an EXIF model that is one: the others are
 * siblings or other markets' names.
 */
export function listsModels(model, name) {
  const alternatives = /\s\/\s|\/(?=[a-z]{0,4}-?\d)/i;
  return alternatives.test(String(name ?? "")) && !/[,/&]|\sand\s/i.test(String(model ?? ""));
}

// ── Regional names ───────────────────────────────────────────────────────
// One camera, a name per market. Canon's EOS xxxD is Rebel in the Americas and
// Kiss in Japan; IXUS is ELPH (PowerShot SDxxx) and IXY; Panasonic's TZ is ZS;
// Minolta's Dynax is Maxxum. A name from another market's family is dropped.
const REGION_MARKERS = {
  Canon: [
    ["americas", /\brebel\b|\belph\b|\bpowershot sd ?\d|(?:^|\s)sd\d{3,4}\b/],
    ["japan", /\bkiss\b|\bixy\b/],
    ["korea", /\beos hi\b/],
    ["europe", /\bixus\b|(?:^|[\s-])\d{3,4}d\b/],
  ],
  Panasonic: [
    ["europe", /(?:^|[\s-])tz\d/],
    ["americas", /(?:^|[\s-])zs\d/],
  ],
  Lumix: null,
  "Konica Minolta": [
    ["europe", /\bdynax\b/],
    ["americas", /\bmaxxum\b/],
  ],
};
REGION_MARKERS.Lumix = REGION_MARKERS.Panasonic;
REGION_MARKERS.Minolta = REGION_MARKERS["Konica Minolta"];

function regionsOf(markers, text) {
  const s = normKey(text);
  return markers.filter(([, re]) => re.test(s)).map(([region]) => region).sort().join(",");
}

// Camera makers whose EXIF models are the cameras' own names, where another
// number in the same series is another camera, or the same one sold elsewhere
// under that number: FinePix F775EXR (US) and F770EXR, Lumix DMC-FX78 and FX77.
const NUMBERED_SERIES_BRANDS = new Set([
  "Canon", "Nikon", "Fujifilm", "Panasonic", "Lumix", "Olympus", "OM System", "Pentax", "Ricoh",
  "Leica", "Sigma", "Hasselblad", "GoPro", "Kodak", "Casio", "Konica Minolta", "Minolta", "Sony",
]);
const codesOf = (text) => [...text.matchAll(/([a-z]+)[\s-]?(\d+)/g)].map(([, letters, digits]) => ({ letters, digits }));
const PANASONIC_CODE = /(?:^|[\s-])(?:dmc|dc)-?([a-z]+)(\d+)/;

/**
 * Whether the name numbers a series the EXIF model has, but never with the
 * model's number ("Fujifilm FinePix F770EXR" for "FinePix F775EXR"); for
 * Panasonic also another series (DMC-TS5, sold as DMC-FT5). A name listing
 * several numbers is fine when one is the model's ("Canon HF R10 / R16"), and
 * a model number that is the name's plus a generation digit is the same
 * camera ("DC-FZ1000 II" for "DC-FZ10002").
 */
export function otherModelNumber(makeKey, model, name) {
  const brand = brandOfMake(makeKey);
  if (!NUMBERED_SERIES_BRANDS.has(brand)) return false;
  const m = withoutBrand(makeKey, unwrap(normKey(model)));
  const n = withoutBrand(makeKey, name);
  const modelCodes = codesOf(m);
  const nameCodes = codesOf(n);
  const same = (modelDigits, nameDigits) => modelDigits === nameDigits
    || (modelDigits.length === nameDigits.length + 1 && modelDigits.startsWith(nameDigits) && /[2-9]$/.test(modelDigits));
  for (const letters of new Set(nameCodes.map((x) => x.letters))) {
    const inModel = modelCodes.filter((c) => c.letters === letters);
    const inName = nameCodes.filter((x) => x.letters === letters);
    if (inModel.length && !inModel.some((c) => inName.some((x) => same(c.digits, x.digits)))) return true;
  }
  if (brand === "Panasonic" || brand === "Lumix") {
    const a = PANASONIC_CODE.exec(m);
    const b = PANASONIC_CODE.exec(n);
    const named = a && nameCodes.some((x) => x.letters === a[1] && same(a[2], x.digits));
    if (a && b && !named) return true;
  }
  return false;
}

/** Whether the EXIF model is one market's name and the name another market's. */
export function regionalRename(makeKey, model, name) {
  const markers = REGION_MARKERS[brandOfMake(makeKey)];
  if (!markers) return false;
  const a = regionsOf(markers, model);
  const b = regionsOf(markers, name);
  return (a || b) !== "" && a !== b;
}

const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, "");

// Words a model can have that tell no camera from another.
const FILLER = new Set(["digital", "camera", "zoom", "video", "mark", "mk"]);

/**
 * Whether the EXIF model names the camera already, so the name only dresses
 * it up: every part of the model is in the name ("CFV 100C/907X" as
 * "Hasselblad 907X & CFV 100C", "E-M1MarkII" as "Olympus OM-D E-M1 Mark II"),
 * or the name is in the model ("M9 Digital Camera" as "Leica M9"). The app
 * shows such a model as EXIF writes it. What is left is a code the name
 * translates: FC9113 as "DJI Air 3S", DSC-RX100M3 as "Sony Cyber-shot
 * DSC-RX100 III".
 */
export function modelIsAName(makeKey, model, name) {
  const m = withoutBrand(makeKey, unwrap(normKey(model)));
  const n = alnum(withoutBrand(makeKey, name));
  const parts = m.split(/[^\p{L}\p{N}]+/u).filter((part) => part && !FILLER.has(part));
  if (!n || !parts.length) return true;
  return parts.every((part) => n.includes(part)) || alnum(m).includes(n);
}

/** Optimal string alignment distance: edits, a swap of two neighbours counting as one. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Whether the EXIF model is the name misspelled ("Canon ESO 600D", "PowerShot
 * SX130 AS"), a model typed by a person: one letter off, or two swapped.
 */
export function misspelledName(makeKey, model, name) {
  const m = alnum(withoutBrand(makeKey, unwrap(normKey(model))));
  const n = alnum(withoutBrand(makeKey, name));
  return m !== n && m.length >= 4 && editDistance(m, n) <= 1;
}

// A camera code: letters, a hyphen, then a number (ILCE-7RM3, DSLR-A850, DC-G9).
const CODE = /(?:^|\s)[a-z]{2,5}-[a-z]*\d/;

/**
 * Whether the name is a code where the EXIF model is not: "Sony ILCE-7RM3"
 * for "alpha 7r iii", a model typed by a person, and the wrong way round.
 */
export function nameIsCode(makeKey, model, name) {
  return CODE.test(withoutBrand(makeKey, name)) && !CODE.test(withoutBrand(makeKey, unwrap(normKey(model))));
}

// ── catmapping ───────────────────────────────────────────────────────────
/** RFC 4180 CSV (quoted fields, "" escapes, line breaks inside quotes). */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === "\"") {
        if (src[i + 1] === "\"") { field += "\""; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === "\"" && field === "") { quoted = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r" && src[i + 1] === "\n") { endRecord(); i += 2; continue; }
    if (ch === "\n" || ch === "\r") { endRecord(); i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || record.length) endRecord();
  return records;
}

/**
 * catmapping rows: first field the EXIF make, last the Commons category,
 * everything between (joined back with commas) the EXIF model.
 * @returns {{ make: string, model: string, category: string }[]}
 */
export function parseCatmapping(text) {
  return parseCsv(text)
    .filter((r) => r.length >= 3)
    .map((r) => ({ make: r[0], model: r.slice(1, -1).join(","), category: r[r.length - 1] }));
}

// A make that is a program, an app, an OS or a website, not a camera maker.
const SOFTWARE_MAKE = new RegExp([
  String.raw`\b(?:adobe|photoshop|lightroom|gimp|picasa|snapseed|instagram|hipstamatic|vsco|navercamera|mobaphoto|corelogic|truehdr|camera360)\b`,
  String.raw`\bpro hdr\b`, String.raw`\bfast burst camera\b`, String.raw`\bcaptured from video\b`, String.raw`\bv\.photos\b`,
  String.raw`\bapp\b`, String.raw`^(?:android|ios)\b`, String.raw`^https?:`, String.raw`^www\.`, String.raw`\.(?:com|net|org|info|cz)\b`,
].join("|"), "i");

/** Whether an EXIF make is software (Adobe, an app, an OS, a website). */
export function isSoftwareMake(make) {
  return SOFTWARE_MAKE.test(normKey(make));
}

/**
 * catmapping rows -> candidate names, and the rows left out.
 * @returns {{ candidates: object[], dropped: { reason: string, make: string, model: string, name?: string }[] }}
 */
export function catmappingCandidates(rows) {
  const candidates = [];
  const dropped = [];
  for (const { make, model, category } of rows) {
    const drop = (reason) => dropped.push({ source: "catmapping", reason, make: normKey(make), model: normKey(model), name: category });
    let cat = String(category ?? "").replace(/\s+/g, " ").trim();
    if (cat.startsWith("Category:")) cat = cat.slice("Category:".length).trim();
    if (/^Taken with /i.test(cat)) cat = cat.slice("Taken with ".length).trim();
    else if (String(category).startsWith("Category:")) { drop("not a camera category"); continue; }
    if (!normKey(make) || !normKey(model)) { drop("empty make or model"); continue; }
    if (isSoftwareMake(make)) { drop("software make"); continue; }
    if (!cat || NOT_A_MODEL.test(cat)) { drop("not a model name"); continue; }
    candidates.push({ source: "catmapping", make: normKey(make), model: normKey(model), rawModel: model, label: cat });
  }
  return { candidates, dropped };
}

// ── Wikidata ─────────────────────────────────────────────────────────────
const LENS_MODEL = "Q109672300";
const SERIES_CLASSES = new Set([
  "Q811701", // model series
  "Q13406463", // Wikimedia list article
  "Q20679033", // digital camera product line
]);

const qid = (uri) => String(uri ?? "").replace(/^.*\//, "");
const classSet = (s) => new Set(String(s ?? "").split(/\s+/).filter(Boolean));
const isSeries = (classes) => [...classes].some((c) => SERIES_CLASSES.has(c));

/**
 * SPARQL JSON rows (see build.mjs) -> candidate names, and the items left out.
 * A drone camera (DJI / Hasselblad / Osmo make) that is part of (P361) a drone
 * is named after the drone: one candidate per drone.
 */
export function wikidataCandidates(sparqlJson) {
  const rows = sparqlJson?.results?.bindings || [];
  const val = (r, k) => r[k]?.value;
  const items = new Map();
  for (const r of rows) {
    const id = qid(val(r, "item"));
    if (!id) continue;
    let it = items.get(id);
    if (!it) {
      it = {
        id,
        sitelinks: Number(val(r, "sitelinks") || 0),
        label: val(r, "label") || "",
        classes: classSet(val(r, "classes")),
        makes: new Set(),
        models: new Map(), // model key -> the EXIF model as written
        drones: new Map(), // drone id -> { label, isDrone, classes }
      };
      items.set(id, it);
    }
    const make = val(r, "exifMake");
    if (make != null && normKey(make)) it.makes.add(normKey(make));
    const model = val(r, "exifModel");
    if (model != null && normKey(model)) {
      if (!it.models.has(normKey(model))) it.models.set(normKey(model), model);
    }
    const drone = qid(val(r, "drone"));
    if (drone && !it.drones.has(drone)) {
      it.drones.set(drone, {
        id: drone,
        label: val(r, "droneLabel") || "",
        isDrone: val(r, "droneIsDrone") === "true",
        classes: classSet(val(r, "droneClasses")),
      });
    }
  }

  const candidates = [];
  const dropped = [];
  for (const it of items.values()) {
    const makes = it.makes.size ? [...it.makes] : [null];
    for (const make of makes) {
      for (const [model, raw] of it.models) {
        const base = { source: "wikidata", item: it.id, qid: Number(it.id.slice(1)), sitelinks: it.sitelinks, make, model, rawModel: raw };
        const drop = (reason) => dropped.push({ ...base, reason, name: it.label });
        if (it.classes.has(LENS_MODEL)) { drop("lens"); continue; }
        if (isSeries(it.classes)) { drop("series or list item"); continue; }
        const drones = DRONE_MAKES.has(make)
          ? [...it.drones.values()].filter((d) => d.isDrone && !isSeries(d.classes) && d.label)
          : [];
        if (drones.length) {
          for (const d of drones) candidates.push({ ...base, label: d.label, drone: d.id });
          continue;
        }
        if (!it.label) { drop("no English label"); continue; }
        if (NOT_A_MODEL.test(it.label)) { drop("not a model name"); continue; }
        // The label is another of the item's EXIF names: the item is one camera
        // sold under several names (EOS 800D / REBEL T7i / Kiss X9i), and the
        // label is some other market's.
        const otherMarket = [...it.models.keys()].some((k) => compact(k) !== compact(model)
          && !addsInformation(make ?? "", k, normalizeBrandSpelling(it.label)));
        candidates.push({ ...base, label: it.label, otherMarket });
      }
    }
  }
  return { candidates, dropped };
}

// ── Choosing ─────────────────────────────────────────────────────────────
/** Why a candidate is not a useful name, or null. Sets c.name. */
export function judge(c) {
  c.name = normalizeBrandSpelling(c.label);
  if (!MAKES.has(normKey(c.make))) return "maker not on the list";
  const phone = PHONE_BRANDS.has(MAKES.get(normKey(c.make)));
  if (!phone && PHONE_NAME.test(c.name)) return "a phone";
  if (phone && APP_SUFFIX.test(normKey(c.rawModel ?? c.model))) return "an app's model";
  if (MARKET_TAG.test(c.name)) return "a market's tag in the name";
  if (!namedWithItsBrand(c.make, c.name)) return "not named with its brand";
  const raw = String(c.rawModel ?? c.model).trim();
  if (modelDisplayName(MAKES.get(normKey(c.make)).toLowerCase(), raw) !== raw) return "a rule names it";
  if (NOT_AN_EXIF_MODEL.test(normKey(c.rawModel ?? c.model))) return "not an EXIF model";
  // Olympus wrote every market's name into one model ("X200,D560Z,C350Z"):
  // already readable, and no one market's name fits all its buyers.
  if (raw.includes(",")) return "EXIF names it in every market";
  const prefix = MODEL_PREFIX.get(normKey(c.make));
  if (prefix && !normKey(c.rawModel ?? c.model).startsWith(prefix)) return "not an EXIF model";
  if (!addsInformation(c.make, c.rawModel ?? c.model, c.name)) return "adds nothing";
  if (lessSpecific(c.make, c.rawModel ?? c.model, c.name)) return "less specific than EXIF";
  if (codeForName(c.make, c.rawModel ?? c.model, c.name)) return "code for a name";
  if (c.otherMarket || regionalRename(c.make, c.rawModel ?? c.model, c.name)) return "regional rename";
  if (otherModelNumber(c.make, c.rawModel ?? c.model, c.name)) return "other model number";
  if (listsModels(c.rawModel ?? c.model, c.name)) return "lists several models";
  if (modelIsAName(c.make, c.rawModel ?? c.model, c.name)) return "EXIF is a name already";
  if (nameIsCode(c.make, c.rawModel ?? c.model, c.name)) return "name is a code";
  if (misspelledName(c.make, c.rawModel ?? c.model, c.name)) return "EXIF misspells the name";
  return null;
}

const betterWikidata = (a, b) => (b.sitelinks - a.sitelinks) || (a.qid - b.qid);

/**
 * Both sources -> { names: { make: { model: name } }, conflicts, dropped, stats }.
 * Wikidata wins over catmapping; among Wikidata items the most sitelinks, then
 * the smallest Q id. A drone camera the items name differently (one camera on
 * several drones) is dropped and reported as a conflict.
 * @param {{ wikidata?: object, catmapping?: string|object[] }} sources
 */
export function buildNames({ wikidata = null, catmapping = "", corrections = CORRECTIONS } = {}) {
  const cm = catmappingCandidates(typeof catmapping === "string" ? parseCatmapping(catmapping) : catmapping);
  const wd = wikidataCandidates(wikidata);
  const dropped = [...cm.dropped, ...wd.dropped];

  // A Wikidata item without an EXIF make takes the makes Commons saw with that exact model.
  const makesByModel = new Map();
  for (const c of cm.candidates) {
    if (!makesByModel.has(c.model)) makesByModel.set(c.model, new Set());
    makesByModel.get(c.model).add(c.make);
  }
  const wdCandidates = [];
  for (const c of wd.candidates) {
    if (c.make) { wdCandidates.push(c); continue; }
    const makes = makesByModel.get(c.model);
    if (!makes?.size) { dropped.push({ ...c, reason: "no EXIF make", name: c.label }); continue; }
    for (const make of makes) wdCandidates.push({ ...c, make });
  }

  const byKey = new Map();
  const keyOf = (c) => `${c.make}\u0000${c.model}`;
  for (const c of [...wdCandidates, ...cm.candidates]) {
    const reason = judge(c);
    if (reason) { dropped.push({ ...c, reason }); continue; }
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, { make: c.make, model: c.model, wikidata: [], catmapping: [] });
    byKey.get(k)[c.source].push(c);
  }

  const names = {};
  const conflicts = [];
  const put = (make, model, name) => { (names[make] ||= {})[model] = name; };
  for (const { make, model, wikidata: w, catmapping: m } of byKey.values()) {
    if (w.length) {
      const distinct = [...new Set(w.map((c) => c.name))];
      if (distinct.length > 1 && w.some((c) => c.drone)) {
        conflicts.push({ make, model, names: distinct.sort(), items: [...new Set(w.map((c) => c.item))].sort() });
        for (const c of [...w, ...m]) dropped.push({ ...c, reason: "drone conflict" });
        continue;
      }
      const [best, ...rest] = [...w].sort(betterWikidata);
      put(make, model, best.name);
      for (const c of [...rest, ...m]) if (c.name !== best.name) dropped.push({ ...c, reason: "outranked" });
      continue;
    }
    // catmapping only: the name most rows give, first in the file on a tie.
    const counts = new Map();
    for (const c of m) counts.set(c.name, (counts.get(c.name) || 0) + 1);
    const top = Math.max(...counts.values());
    const best = m.find((c) => counts.get(c.name) === top);
    put(make, model, best.name);
    for (const c of m) if (c.name !== best.name) dropped.push({ ...c, reason: "outranked" });
  }

  // Reviewed corrections (corrections.mjs): a name replaces, null drops.
  const unusedCorrections = [];
  for (const [make, model, name] of corrections) {
    if (!names[make]?.[model]) { unusedCorrections.push(`${make} / ${model}`); continue; }
    if (name) names[make][model] = name;
    else {
      delete names[make][model];
      if (!Object.keys(names[make]).length) delete names[make];
      dropped.push({ source: "review", reason: "corrected", make, model });
    }
  }

  const sorted = {};
  for (const make of Object.keys(names).sort()) {
    sorted[make] = {};
    for (const model of Object.keys(names[make]).sort()) sorted[make][model] = names[make][model];
  }
  conflicts.sort((a, b) => (a.make + a.model < b.make + b.model ? -1 : 1));

  const droppedByReason = {};
  for (const d of dropped) {
    const k = `${d.source}: ${d.reason}`;
    droppedByReason[k] = (droppedByReason[k] || 0) + 1;
  }
  return {
    names: sorted,
    conflicts,
    dropped,
    stats: {
      entries: Object.values(sorted).reduce((n, models) => n + Object.keys(models).length, 0),
      perMake: Object.entries(sorted).map(([k, v]) => [k, Object.keys(v).length]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      droppedByReason,
      unusedCorrections,
    },
  };
}
