import { test } from "node:test";
import assert from "node:assert/strict";
import { CORRECTIONS } from "./corrections.mjs";
import {
  addsInformation,
  brandOfMake,
  buildNames,
  isSoftwareMake,
  MAKES,
  misspelledName,
  modelIsAName,
  nameIsCode,
  namedWithItsBrand,
  normKey,
  normalizeBrandSpelling,
  parseCatmapping,
  parseCsv,
  regionalRename,
  wikidataCandidates,
} from "./filter.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────
const lit = (value) => ({ type: "literal", value: String(value) });
const entity = (id) => ({ type: "uri", value: `http://www.wikidata.org/entity/${id}` });

/** One SPARQL result row, as build.mjs's query returns them. */
function row({ item, make, model, label, sitelinks = 1, classes = "Q20741022", drone, droneLabel, droneClasses, droneIsDrone }) {
  const r = { item: entity(item), exifModel: lit(model), sitelinks: lit(sitelinks) };
  if (make != null) r.exifMake = lit(make);
  if (label != null) r.label = lit(label);
  if (classes) r.classes = lit(classes);
  if (drone) {
    r.drone = entity(drone);
    if (droneLabel != null) r.droneLabel = lit(droneLabel);
    if (droneClasses) r.droneClasses = lit(droneClasses);
    if (droneIsDrone) r.droneIsDrone = lit("true");
  }
  return r;
}
const sparql = (...rows) => ({ head: { vars: [] }, results: { bindings: rows.map(row) } });
// The rules alone; the reviewed corrections have a test of their own.
const names = (wikidata, catmapping = "", corrections = []) => buildNames({ wikidata: wikidata ?? sparql(), catmapping, corrections });

const UAV = "Q484000";
const MODEL_SERIES = "Q811701";

// ── keys ─────────────────────────────────────────────────────────────────
test("keys are the EXIF value with spaces collapsed, trimmed, lower-cased", () => {
  assert.equal(normKey("  NIKON   CORPORATION "), "nikon corporation");
  assert.equal(normKey("ILCE-7CM2"), "ilce-7cm2");
  assert.equal(normKey(null), "");
});

test("no fuzzy matching: DC-G9M2 and DMC-G9M2 are different keys", () => {
  const { names: out } = names(sparql(
    { item: "Q1", make: "Panasonic", model: "DC-G9M2", label: "Panasonic Lumix DC-G9 II" },
  ));
  assert.equal(out.panasonic["dc-g9m2"], "Panasonic Lumix DC-G9 II");
  assert.equal(out.panasonic["dmc-g9m2"], undefined);
});

// ── Wikidata ─────────────────────────────────────────────────────────────
test("lens items (instance of lens model) are skipped", () => {
  const { names: out, stats } = names(sparql(
    { item: "Q68867227", make: "Canon", model: "EF85mm f/1.2L II USM", label: "Canon EF 85mm F1.2L II USM", classes: "Q109672300" },
    { item: "Q2", make: "DJI", model: "FC3411", label: "DJI Air 2S" },
  ));
  assert.deepEqual(out, { dji: { fc3411: "DJI Air 2S" } });
  assert.equal(stats.droppedByReason["wikidata: lens"], 1);
});

test("English label, else the mul label (the query coalesces them); no label is dropped", () => {
  const { names: out, stats } = names(sparql(
    { item: "Q1", make: "SONY", model: "DSC-RX100M3", label: "Sony Cyber-shot DSC-RX100 III" },
    { item: "Q2", make: "SONY", model: "DSC-RX100M4", label: null },
  ));
  assert.deepEqual(out, { sony: { "dsc-rx100m3": "Sony Cyber-shot DSC-RX100 III" } });
  assert.equal(stats.droppedByReason["wikidata: no English label"], 1);
});

test("a DJI / Hasselblad / Osmo camera part of a drone is named after the drone", () => {
  const { names: out } = names(sparql(
    { item: "Q138773668", make: "DJI", model: "FC9113", label: "DJI FC9113", drone: "Q130616704", droneLabel: "DJI Air 3S", droneClasses: UAV, droneIsDrone: true },
    { item: "Q133889484", make: "Hasselblad", model: "L1D-20c", label: "Hasselblad L1D-20c", drone: "Q66499018", droneLabel: "DJI Mavic 2 Pro", droneClasses: "Q43965", droneIsDrone: true },
    { item: "Q139603645", make: "Osmo", model: "OQ001E", label: "Osmo OQ001E", drone: "Q138679461", droneLabel: "DJI Avata 360", droneClasses: UAV, droneIsDrone: true },
  ));
  assert.equal(out.dji.fc9113, "DJI Air 3S");
  assert.equal(out.hasselblad["l1d-20c"], "DJI Mavic 2 Pro");
  assert.equal(out.osmo.oq001e, "DJI Avata 360");
});

test("P361 is used only when the target is a drone, never a list or a series", () => {
  const { names: out } = names(sparql(
    // "part of" a Wikipedia list, not a drone: the camera keeps its own label (a code: nothing added)
    { item: "Q1", make: "DJI", model: "FC1234", label: "DJI FC1234", drone: "Q9", droneLabel: "List of DJI products", droneClasses: "Q13406463" },
    // a model series that is also a subclass of UAV: still not one drone
    { item: "Q98021455", make: "DJI", model: "FC330", label: "DJI FC330", drone: "Q19840564", droneLabel: "DJI Phantom", droneClasses: MODEL_SERIES, droneIsDrone: true },
    // part of something, but the make is not a drone make: the label stands
    { item: "Q3", make: "SONY", model: "DSC-RX0M2", label: "Sony DSC-RX0 II", drone: "Q4", droneLabel: "Some kit", droneIsDrone: true },
  ));
  assert.equal(out.dji, undefined);
  assert.equal(out.sony["dsc-rx0m2"], "Sony DSC-RX0 II");
});

test("series and list items are skipped (their label names a family)", () => {
  const { names: out, stats } = names(sparql(
    { item: "Q26721405", make: "DJI", model: "DJI Pocket", label: "DJI Osmo", classes: MODEL_SERIES, sitelinks: 5 },
  ));
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["wikidata: series or list item"], 1);
});

test("an item without an EXIF make takes the makes Commons saw with that exact model", () => {
  const catmapping = "NIKON,E4500,Nikon Coolpix 4500\n";
  const { names: out, stats } = names(sparql(
    { item: "Q1", make: null, model: "E4500", label: "Nikon Coolpix 4500" },
    { item: "Q5", make: null, model: "PowerSlide 3600", label: "PowerSlide 3600 Pro" },
  ), catmapping);
  assert.deepEqual(out, { nikon: { e4500: "Nikon Coolpix 4500" } });
  assert.equal(stats.droppedByReason["wikidata: no EXIF make"], 1);
});

// ── adds information ─────────────────────────────────────────────────────
test("a name is kept only if it adds to the EXIF model beyond case, spaces and the brand", () => {
  assert.equal(addsInformation("sony", "ILCE-7CM2", "Sony ILCE-7CM2"), false);
  assert.equal(addsInformation("sony", "ILCE-7CM2", "Sony α7C II"), true);
  assert.equal(addsInformation("fujifilm", "X-T3", "Fujifilm X-T3"), false);
  assert.equal(addsInformation("leica camera ag", "LEICA M11-P", "Leica M11-P"), false);
  assert.equal(addsInformation("leica camera ag", "M9 Digital Camera", "Leica M9"), true);
  assert.equal(addsInformation("nikon corporation", "NIKON Z5_2", "Nikon Z5II"), true);
  assert.equal(addsInformation("panasonic", "DMC-GH4", "Panasonic Lumix DMC-GH4"), false);
  assert.equal(addsInformation("ricoh imaging company, ltd.", "PENTAX K-1", "Pentax K-1"), false);
  assert.equal(addsInformation("dji", "[FC9113]", "DJI FC9113"), false);
  assert.equal(addsInformation("dji", "FC9113", "DJI"), false);

  const { names: out, stats } = names(sparql(
    { item: "Q1", make: "SONY", model: "DSC-RX100M3", label: "Sony DSC-RX100M3" },
    { item: "Q2", make: "FUJIFILM", model: "X-T3", label: "Fujifilm X-T3" },
    { item: "Q3", make: "NIKON", model: "E4500", label: "Nikon Coolpix 4500" },
  ));
  assert.deepEqual(out, { nikon: { e4500: "Nikon Coolpix 4500" } });
  assert.equal(stats.droppedByReason["wikidata: adds nothing"], 2);
});

test("an EXIF model that names the camera already is left as it is; a code is translated", () => {
  assert.equal(modelIsAName("leica camera ag", "M9 Digital Camera", "Leica M9"), true);
  assert.equal(modelIsAName("hasselblad", "CFV 100C/907X", "Hasselblad 907X & CFV 100C"), true);
  assert.equal(modelIsAName("olympus corporation", "E-M1MarkII", "Olympus OM-D E-M1 Mark II"), true);
  assert.equal(modelIsAName("ricoh imaging company, ltd.", "PENTAX K-1 Mark II", "Pentax K-1 II"), true);
  assert.equal(modelIsAName("eastman kodak company", "KODAK C310 DIGITAL CAMERA", "Kodak EasyShare C310"), true);
  assert.equal(modelIsAName("dji", "FC9113", "DJI Air 3S"), false);
  assert.equal(modelIsAName("sony", "DSC-RX100M3", "Sony Cyber-shot DSC-RX100 III"), false);
  assert.equal(modelIsAName("panasonic", "DC-G9M2", "Panasonic Lumix DC-G9 II"), false);

  const { names: out, stats } = names(null, "Hasselblad,CFV 100C/907X,Hasselblad 907X & CFV 100C\nDJI,FC9113,DJI Air 3S\n");
  assert.deepEqual(out, { dji: { fc9113: "DJI Air 3S" } });
  assert.equal(stats.droppedByReason["catmapping: EXIF is a name already"], 1);
});

// ── which makers ─────────────────────────────────────────────────────────
test("only makers still selling cameras, and the big Chinese phone makers, by the Make they write now", () => {
  assert.equal(MAKES.get("nikon corporation"), "Nikon");
  assert.equal(MAKES.get("osmo"), "DJI");
  assert.equal(MAKES.get("yingling innovations pte. ltd."), "Antigravity");
  assert.equal(MAKES.get("oppo"), "OPPO");
  assert.equal(MAKES.has("zte"), false);
  assert.equal(MAKES.has("huawei"), false); // one in six named another market's phone
  assert.equal(MAKES.has("honor"), false);
  assert.equal(MAKES.has("olympus imaging corp."), false);
  assert.equal(MAKES.has("samsung"), false);
  const { names: out, stats } = names(null, [
    "EASTMAN KODAK COMPANY,KODAK DX6490 ZOOM DIGITAL CAMERA,Kodak EasyShare DX6490",
    "OLYMPUS IMAGING CORP.,\"u850SW,S850SW\",Olympus µ 850 SW",
    "SAMSUNG,SM-G935F,Samsung Galaxy S7 Edge",
    "Kodak Portra 400,Rolleiflex model K8 T2,Rolleiflex K8 T2",
    "DJI,FC9113,DJI Air 3S",
  ].join("\n"));
  assert.deepEqual(out, { dji: { fc9113: "DJI Air 3S" } });
  assert.equal(stats.droppedByReason["catmapping: maker not on the list"], 4);
});

test("a Chinese phone's code is named; a sub-brand's phone goes by the sub-brand", () => {
  assert.equal(normalizeBrandSpelling("Xiaomi Redmi Note 13 Pro+"), "Redmi Note 13 Pro+");
  assert.equal(normalizeBrandSpelling("Xiaomi Pocophone F1"), "POCO F1");
  assert.equal(normalizeBrandSpelling("OPPO A57s"), "OPPO A57s");
  const { names: out } = names(null, [
    "HUAWEI,ELS-NX9,Huawei P40 Pro",
    "Xiaomi,23090RA98C,Xiaomi Redmi Note 13 Pro+",
    "OPPO,CPH2385,OPPO A57s",
    "Xiaomi,Redmi Note 9 Pro,Xiaomi Redmi Note 9 Pro",
  ].join("\n"));
  assert.deepEqual(out, {
    oppo: { cph2385: "OPPO A57s" },
    xiaomi: { "23090ra98c": "Redmi Note 13 Pro+" },
  });
});

test("phone names in each brand's own spelling", () => {
  assert.equal(normalizeBrandSpelling("vivo iQOO 9 SE"), "iQOO 9 SE");
  assert.equal(normalizeBrandSpelling("vivo V21E 5G"), "vivo V21e 5G");
  assert.equal(normalizeBrandSpelling("vivo Y15S"), "vivo Y15s");
  assert.equal(normalizeBrandSpelling("realme Narzo 20A"), "realme narzo 20A");
  assert.equal(normalizeBrandSpelling("realme NARZO 70 Pro 5G"), "realme NARZO 70 Pro 5G");
  assert.equal(normalizeBrandSpelling("DJI Zenmuse X5S"), "DJI Zenmuse X5S"); // only vivo's letters
});

test("a phone model an app appended to, or a name with a market's tag, is left to EXIF", () => {
  const { names: out, stats } = names(null, [
    "realme,RMX2050 (RMX2050),realme Narzo 20A",
    "Xiaomi,M2101K7BI (Camera Super Pixel),Redmi Note 10S",
    "OnePlus,ONEPLUS A6013 P3XL,OnePlus 6T",
    "OnePlus,ONEPLUS A5010(shot on gcam),OnePlus 5T",
    "Xiaomi,21091116AC,Redmi Note 11 (China)",
    "realme,RMX2050,realme Narzo 20A",
  ].join("\n"));
  assert.deepEqual(out, { realme: { rmx2050: "realme narzo 20A" } });
  assert.equal(stats.droppedByReason["catmapping: an app's model"], 4);
  assert.equal(stats.droppedByReason["catmapping: a market's tag in the name"], 1);
});

test("a phone under a camera maker's name, or a name with another brand, is dropped", () => {
  assert.equal(namedWithItsBrand("panasonic", "Panasonic Lumix DC-G9 II"), true);
  assert.equal(namedWithItsBrand("panasonic", "Lumix DC-G9 II"), true);
  assert.equal(namedWithItsBrand("hasselblad", "DJI Mavic 2 Pro"), true);
  assert.equal(namedWithItsBrand("olympus corporation", "Nikon Coolpix 5700"), false);
  assert.equal(namedWithItsBrand("sony", "Cyber-shot DSC-RX100"), false);
  const { names: out, stats } = names(null, "SONY,G8341,Sony Xperia XZ1\nOLYMPUS CORPORATION,GT-I8200,Samsung Galaxy S III Mini VE\n");
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: a phone"], 1);
  assert.equal(stats.droppedByReason["catmapping: not named with its brand"], 1);
});

test("a model no camera writes is dropped: a back on a body, a lens after the model, Canon without Canon", () => {
  const { names: out, stats } = names(null, [
    "Hasselblad,Ixpress 96 - Hasselblad H1,Hasselblad Imacon Ixpress 96",
    "\"RICOH IMAGING COMPANY, LTD.\",GXR MOUNT A12_Summicron-M 35,Ricoh GXR A12",
    "Canon,5D Mark 3,Canon EOS 5D Mark III",
  ].join("\n"));
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: not an EXIF model"], 3);
});

test("what the rules name is left to them", () => {
  const { names: out, stats } = names(null, "SONY,ILCE-7M4,Sony α7 IV\nNIKON CORPORATION,NIKON Z 6_2,Nikon Z 6 II\nCanon,Canon EOS R6m2,Canon EOS R6 Mark II\n");
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: a rule names it"], 3);
});

test("a model typed by a person: a name as a code, or the name misspelled", () => {
  assert.equal(nameIsCode("sony", "alpha 7R III", "Sony ILCE-7RM3"), true);
  assert.equal(nameIsCode("sony", "DSC-RX100M3", "Sony Cyber-shot DSC-RX100 III"), false);
  assert.equal(misspelledName("canon", "Canon ESO 600D", "Canon EOS 600D"), true);
  assert.equal(misspelledName("canon", "Canon PowerShot SX130 AS", "Canon PowerShot SX130 IS"), true);
  assert.equal(misspelledName("panasonic", "DC-G9M2", "Panasonic Lumix DC-G9 II"), false);
  const { names: out, stats } = names(null, "SONY,alpha 7R III,Sony ILCE-7RM3\nCanon,Canon ESO 600D,Canon EOS 600D\n");
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: name is a code"], 1);
  assert.equal(stats.droppedByReason["catmapping: EXIF misspells the name"], 1);
});

test("a name that leaves out the model's number is dropped", () => {
  const { names: out, stats } = names(null, "Canon,Canon EOS 5D Mark II,Canon EOS 5D\n");
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: less specific than EXIF"], 1);
});

test("a camera code is not a name for a DJI model that is one", () => {
  const { names: out } = names(null, "DJI,DJI Mini 3 Pro,DJI FC3582\nDJI,FC3582,DJI Mini 3 Pro\n");
  assert.deepEqual(out, { dji: { fc3582: "DJI Mini 3 Pro" } });
});

// ── regional names ───────────────────────────────────────────────────────
test("regional renames are dropped: EXIF one market's name, the label another's", () => {
  assert.equal(regionalRename("canon", "Canon EOS REBEL T7i", "Canon EOS 800D"), true);
  assert.equal(regionalRename("canon", "Canon EOS Kiss X9i", "Canon EOS 800D"), true);
  assert.equal(regionalRename("canon", "Canon PowerShot SD1100 IS", "Canon Digital IXUS 80 IS"), true);
  assert.equal(regionalRename("canon", "Canon EOS 800D", "Canon EOS 800D"), false);
  assert.equal(regionalRename("canon", "Canon EOS R6m2", "Canon EOS R6 Mark II"), false);
  assert.equal(regionalRename("panasonic", "DMC-ZS50", "Panasonic Lumix DMC-TZ70"), true);
  assert.equal(regionalRename("konica minolta", "MAXXUM 7D", "Konica Minolta Dynax 7D"), true);

  const { names: out, stats } = names(sparql(
    { item: "Q28790013", make: "Canon", model: "Canon EOS REBEL T7i", label: "Canon EOS 800D", sitelinks: 14 },
    { item: "Q28790013", make: "Canon", model: "Canon EOS 800D", label: "Canon EOS 800D", sitelinks: 14 },
  ), "Canon,Canon EOS Rebel T7i,Canon EOS 800D\n");
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["wikidata: regional rename"], 1);
  assert.equal(stats.droppedByReason["catmapping: regional rename"], 1);
});

test("a label that is another of the item's EXIF names is another market's", () => {
  // Panasonic's G80 (Europe) is the G85 in the Americas and the G81 elsewhere.
  const { names: out } = names(sparql(
    { item: "Q1", make: "Panasonic", model: "DC-G90", label: "Panasonic Lumix DC-G90" },
    { item: "Q1", make: "Panasonic", model: "DC-G95", label: "Panasonic Lumix DC-G90" },
  ));
  assert.deepEqual(out, {});
});

test("another model number in the same series is another camera, or another market's", () => {
  const catmapping = [
    "FUJIFILM,FinePix F775EXR,Fujifilm FinePix F770EXR",
    "Panasonic,DMC-TS5,Panasonic Lumix DMC-FT5",
    "Panasonic,DC-FZ10002,Panasonic Lumix DC-FZ1000 II",
    "SONY,DCR-SX83E,Sony DCR-SX73E",
  ].join("\n");
  const { names: out, stats } = names(null, catmapping);
  assert.deepEqual(out, { panasonic: { "dc-fz10002": "Panasonic Lumix DC-FZ1000 II" } });
  assert.equal(stats.droppedByReason["catmapping: other model number"], 3);
});

test("a name listing several models is dropped; so is a model naming the camera in every market", () => {
  const catmapping = [
    "Canon,Canon LEGRIA HF R16,Canon HF R10 / R16",
    "OLYMPUS CORPORATION,\"X200,D560Z,C350Z\",Olympus Camedia C-350 Zoom",
  ].join("\n");
  const { names: out, stats } = names(null, catmapping);
  assert.deepEqual(out, {});
  assert.equal(stats.droppedByReason["catmapping: lists several models"], 1);
  assert.equal(stats.droppedByReason["catmapping: EXIF names it in every market"], 1);
});

test("reviewed corrections replace or drop a source's name; one that no longer matches is reported", () => {
  const catmapping = "DJI,AC003,DJI Osmo Action 3\nDJI,FC2220,DJI Mavic 2 Zoom\nDJI,FC3411,DJI Air 2S\n";
  const corrections = [
    ["dji", "ac003", "DJI Osmo Action 4", "why"],
    ["dji", "fc2220", null, "why"],
    ["dji", "fc0000", null, "gone from the sources"],
  ];
  const { names: out, stats } = names(null, catmapping, corrections);
  assert.deepEqual(out, { dji: { ac003: "DJI Osmo Action 4", fc3411: "DJI Air 2S" } });
  assert.deepEqual(stats.unusedCorrections, ["dji / fc0000"]);
  // The shipped corrections all match the sources' entries they correct.
  for (const [make, model, name, why] of CORRECTIONS) {
    assert.equal(make, normKey(make));
    assert.equal(model, normKey(model));
    assert.ok(name === null || (typeof name === "string" && name), `${make} / ${model}`);
    assert.ok(why, `${make} / ${model} says why`);
  }
});

// ── choosing ─────────────────────────────────────────────────────────────
test("Wikidata wins over catmapping; then most sitelinks, then the smallest Q id", () => {
  const { names: out } = names(sparql(
    { item: "Q20", make: "DJI", model: "FC3411", label: "DJI Air 2S drone", sitelinks: 3 },
    { item: "Q10", make: "DJI", model: "FC3411", label: "DJI Air 2S", sitelinks: 9 },
    { item: "Q7", make: "NIKON", model: "E4500", label: "Nikon Coolpix 4500 (2002)", sitelinks: 2 },
    { item: "Q5", make: "NIKON", model: "E4500", label: "Nikon Coolpix 4500", sitelinks: 2 },
  ), "DJI,FC3411,DJI Air 2S Fly More\n");
  assert.equal(out.dji.fc3411, "DJI Air 2S");
  assert.equal(out.nikon.e4500, "Nikon Coolpix 4500");
});

test("a drone camera the items name differently is dropped and reported as a conflict", () => {
  const drone = (droneId, droneLabel) => ({
    item: "Q133886275", make: "Hasselblad", model: "L2D-20c", label: "Hasselblad L2D-20c",
    drone: droneId, droneLabel, droneClasses: UAV, droneIsDrone: true,
  });
  const { names: out, conflicts } = names(sparql(
    drone("Q109920827", "DJI Mavic 3"),
    drone("Q138608456", "DJI Mavic 3 Classic"),
    drone("Q130616685", "DJI Mavic 3 Pro"),
    { item: "Q138773663", make: "DJI", model: "FC4382", label: "DJI FC4382", drone: "Q130616685", droneLabel: "DJI Mavic 3 Pro", droneClasses: UAV, droneIsDrone: true },
  ), "Hasselblad,L2D-20c,DJI Mavic 3\n");
  assert.deepEqual(out, { dji: { fc4382: "DJI Mavic 3 Pro" } });
  assert.deepEqual(conflicts, [{
    make: "hasselblad",
    model: "l2d-20c",
    names: ["DJI Mavic 3", "DJI Mavic 3 Classic", "DJI Mavic 3 Pro"],
    items: ["Q133886275"],
  }]);
});

test("items that agree on a drone camera are no conflict", () => {
  const { names: out, conflicts } = names(sparql(
    { item: "Q107674157", make: "DJI", model: "FC3411", label: "DJI Air 2S", classes: UAV },
    { item: "Q138795432", make: "DJI", model: "FC3411", label: "DJI FC3411", drone: "Q107674157", droneLabel: "DJI Air 2S", droneClasses: UAV, droneIsDrone: true },
  ));
  assert.deepEqual(out, { dji: { fc3411: "DJI Air 2S" } });
  assert.deepEqual(conflicts, []);
});

// ── brand spelling ───────────────────────────────────────────────────────
test("the brand at the start of a name is spelled the usual way; the rest is left alone", () => {
  assert.equal(normalizeBrandSpelling("NIKON Z5II"), "Nikon Z5II");
  assert.equal(normalizeBrandSpelling("SONY DSC-RX100M7"), "Sony DSC-RX100M7");
  assert.equal(normalizeBrandSpelling("FUJIFILM X-T3 WW"), "Fujifilm X-T3 WW");
  assert.equal(normalizeBrandSpelling("dji Air 3S"), "DJI Air 3S");
  assert.equal(normalizeBrandSpelling("SONY ERICSSON K800i"), "Sony Ericsson K800i");
  assert.equal(normalizeBrandSpelling("Sonya 5"), "Sonya 5");
  assert.equal(normalizeBrandSpelling("OM SYSTEM OM‑1"), "OM System OM-1");
  assert.equal(normalizeBrandSpelling("iPhone 15 Pro"), "iPhone 15 Pro");
  assert.equal(normalizeBrandSpelling("Sony Alpha 77 II"), "Sony α77 II"); // as the rules name Sony's bodies
  assert.equal(normalizeBrandSpelling("SONY ALPHA 900"), "Sony α900");

  const { names: out } = names(sparql({ item: "Q1", make: "NIKON", model: "E4500", label: "NIKON Coolpix 4500" }));
  assert.equal(out.nikon.e4500, "Nikon Coolpix 4500");
});

test("a make's brand", () => {
  assert.equal(brandOfMake("NIKON CORPORATION"), "Nikon");
  assert.equal(brandOfMake("EASTMAN KODAK COMPANY"), "Kodak");
  assert.equal(brandOfMake("Sony Ericsson"), "Sony Ericsson");
  assert.equal(brandOfMake("Arashi Vision"), "Insta360");
  assert.equal(brandOfMake("Osmo"), "DJI");
  assert.equal(brandOfMake("ACME"), null);
});

// ── catmapping ───────────────────────────────────────────────────────────
test("catmapping: first field the make, last the category, everything between the model", () => {
  const text = [
    "Canon,Canon EOS R6m2,Canon EOS R6 Mark II",
    "Hasselblad,CFV 100C/907X,Hasselblad 907X & CFV 100C",
    "Leica Camera AG,M9 Digital Camera,Leica M9",
    "DJI,FC9113,DJI Air 3S",
    "Apple,iPad3,6,iPad 4",
    "\"ABILITY ENTERPRISE CO., LTD\",VC7320Z,Ability Enterprise VC7320Z",
    "AGFA,\"\"\"Click\"\"\",Agfa Click",
    "\"IPort: Device=3\r\nCamera: Adimec\",,Adimec-2000m/S",
    "",
  ].join("\r\n");
  assert.deepEqual(parseCatmapping(text), [
    { make: "Canon", model: "Canon EOS R6m2", category: "Canon EOS R6 Mark II" },
    { make: "Hasselblad", model: "CFV 100C/907X", category: "Hasselblad 907X & CFV 100C" },
    { make: "Leica Camera AG", model: "M9 Digital Camera", category: "Leica M9" },
    { make: "DJI", model: "FC9113", category: "DJI Air 3S" },
    { make: "Apple", model: "iPad3,6", category: "iPad 4" },
    { make: "ABILITY ENTERPRISE CO., LTD", model: "VC7320Z", category: "Ability Enterprise VC7320Z" },
    { make: "AGFA", model: "\"Click\"", category: "Agfa Click" },
    { make: "IPort: Device=3\r\nCamera: Adimec", model: "", category: "Adimec-2000m/S" },
  ]);
  assert.deepEqual(parseCsv("a,b\n\nc,d"), [["a", "b"], ["c", "d"]]);

  const { names: out } = names(null, text);
  assert.deepEqual(out, { dji: { fc9113: "DJI Air 3S" } });
});

test("catmapping: rows that are not cameras are dropped", () => {
  const text = [
    "Acer,ScanWit 2720,Category:Scanned with Acer / BenQ ScanWit 2720",
    "Canon,PowerShot S100,Category:CanonS100 (special case)",
    "Apple,iPad 2G,iPad (ambiguous)",
    "SONY,MAVICA,unidentified Sony Mavica",
    ",Canon EOS R6m2,Canon EOS R6 Mark II",
    "DJI,FC9113,Category:Taken with DJI Air 3S",
  ].join("\n");
  const { names: out, stats } = names(null, text);
  assert.deepEqual(out, { dji: { fc9113: "DJI Air 3S" } });
  assert.equal(stats.droppedByReason["catmapping: not a camera category"], 2);
  assert.equal(stats.droppedByReason["catmapping: not a model name"], 2);
  assert.equal(stats.droppedByReason["catmapping: empty make or model"], 1);
});

test("catmapping: software makes are dropped", () => {
  for (const make of ["Adobe Systems Inc.", "Adobe Photoshop CS6", "camera360", "Apple + Pro HDR",
    "Fast Burst Camera for Android GT-I9100G", "iOS v9.0.1", "Android", "http://politik.in2pic.com",
    "MobaPhoto - http://mobaphoto.mobatek.net", "www.VIP-Europe.com", "NaverCamera (skt_kr : av15)"]) {
    assert.equal(isSoftwareMake(make), true, make);
  }
  for (const make of ["Apple", "Google", "Microsoft", "CAMERA", "Digital Camera", "DxO", "Facebook"]) {
    assert.equal(isSoftwareMake(make), false, make);
  }
  const { names: out, stats } = names(null, "Adobe Systems Inc.,ILCE-6300,Sony α6300\nDJI,FC3411,DJI Air 2S\n");
  assert.deepEqual(out, { dji: { fc3411: "DJI Air 2S" } });
  assert.equal(stats.droppedByReason["catmapping: software make"], 1);
});

test("catmapping only: the name most rows give", () => {
  const { names: out } = names(null, "DJI,FC3170,DJI Air 2\ndji,FC3170,DJI Mavic Air 2\nDJI,FC3170,DJI Mavic Air 2\n");
  assert.deepEqual(out, { dji: { fc3170: "DJI Mavic Air 2" } });
});

test("one person's camera is not a model name", () => {
  const { names: out } = names(sparql({ item: "Q1", make: "Canon", model: "Canon EOS 750D", label: "AFF's Canon EOS 750D" }));
  assert.deepEqual(out, {});
});

test("wikidataCandidates keeps one row per item and model, whatever the join multiplied", () => {
  const { candidates } = wikidataCandidates(sparql(
    { item: "Q1", make: "SAMSUNG", model: "SM-G900F", label: "Samsung Galaxy S5" },
    { item: "Q1", make: "samsung", model: "SM-G900F", label: "Samsung Galaxy S5" },
    { item: "Q1", make: "SAMSUNG", model: "SM-G900F ", label: "Samsung Galaxy S5" },
  ));
  assert.equal(candidates.length, 1);
});
