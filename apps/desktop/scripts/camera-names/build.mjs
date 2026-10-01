#!/usr/bin/env node
// Builds camera-names/generated.json: camera display names by EXIF make and
// model, from two CC0 sources, Wikidata and the Commons "takenwith"
// catmapping. The rules live in filter.mjs; why, in camera-names/README.md.
//
//   node apps/desktop/scripts/camera-names/build.mjs
//   node apps/desktop/scripts/camera-names/build.mjs --wikidata wd.json --catmapping catmapping
//
// --wikidata / --catmapping read a saved copy instead of fetching (the SPARQL
// JSON result, and the raw catmapping file). Review the diff before committing.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildNames } from "./filter.mjs";

const USER_AGENT = "AfterFrame camera-names build (https://github.com/YIWANG3/AfterFrame)";
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const CATMAPPING_URL = "https://raw.githubusercontent.com/garyhouston/takenwith/master/catmapping";
const OUT = fileURLToPath(new URL("../../camera-names/generated.json", import.meta.url));

// Every item with an Exif model (P2009), its Exif make (P2010) if any, its
// English label (else the language-neutral "mul" one), sitelinks and classes
// (P31: filter.mjs skips lenses and series). For a DJI / Hasselblad / Osmo
// camera also what it is part of (P361) and whether that is a drone: an
// instance or subclass of unmanned aerial vehicle, quadcopter or camera drone
// model, with its own classes (a model series is not a drone).
export const SPARQL = `
SELECT ?item ?exifMake ?exifModel ?label ?sitelinks ?classes ?drone ?droneLabel ?droneClasses ?droneIsDrone WHERE {
  ?item wdt:P2009 ?exifModel ;
        wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?item wdt:P2010 ?exifMake . }
  OPTIONAL { ?item rdfs:label ?enL  FILTER(LANG(?enL)  = "en") }
  OPTIONAL { ?item rdfs:label ?mulL FILTER(LANG(?mulL) = "mul") }
  BIND(COALESCE(?enL, ?mulL) AS ?label)
  OPTIONAL {
    SELECT ?item (GROUP_CONCAT(DISTINCT STRAFTER(STR(?cls), "/entity/"); separator=" ") AS ?classes) WHERE {
      ?item wdt:P2009 [] ; wdt:P31 ?cls .
    } GROUP BY ?item
  }
  OPTIONAL {
    ?item wdt:P2010 ?droneMake ; wdt:P361 ?drone .
    FILTER(LCASE(STR(?droneMake)) IN ("dji", "hasselblad", "osmo"))
    OPTIONAL { ?drone rdfs:label ?dEn  FILTER(LANG(?dEn)  = "en") }
    OPTIONAL { ?drone rdfs:label ?dMul FILTER(LANG(?dMul) = "mul") }
    BIND(COALESCE(?dEn, ?dMul) AS ?droneLabel)
    OPTIONAL {
      SELECT ?drone (GROUP_CONCAT(DISTINCT STRAFTER(STR(?dc), "/entity/"); separator=" ") AS ?droneClasses) WHERE {
        ?cam wdt:P2009 [] ; wdt:P361 ?drone . ?drone wdt:P31 ?dc .
      } GROUP BY ?drone
    }
    OPTIONAL {
      SELECT DISTINCT ?drone ?droneIsDrone WHERE {
        VALUES ?droneClass { wd:Q484000 wd:Q43965 wd:Q140559271 }
        ?cam wdt:P2009 [] ; wdt:P361 ?drone .
        ?drone (wdt:P31|wdt:P279)/wdt:P279* ?droneClass .
        BIND(true AS ?droneIsDrone)
      }
    }
  }
}
`;

const SOURCES = [
  {
    name: "Wikidata: items with an Exif model (P2009) and Exif make (P2010)",
    url: "https://www.wikidata.org/wiki/Property:P2009",
    license: "CC0 1.0",
  },
  {
    name: "takenwith catmapping: EXIF make and model to Wikimedia Commons \"Taken with\" categories",
    url: "https://github.com/garyhouston/takenwith",
    license: "CC0 1.0",
  },
];

async function fetchText(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...init.headers },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${url.split("?")[0]}: HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function loadWikidata(file) {
  if (file) return JSON.parse(await readFile(file, "utf8"));
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(SPARQL)}`;
  return JSON.parse(await fetchText(url, { headers: { Accept: "application/sparql-results+json" } }));
}

async function loadCatmapping(file) {
  return file ? readFile(file, "utf8") : fetchText(CATMAPPING_URL);
}

const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The file: keys sorted by code point, one name per line (JSON.stringify would put "500" before "1100d"). */
export function serialize(doc) {
  const q = (v) => JSON.stringify(v);
  const head = Object.entries(doc)
    .filter(([k]) => k !== "names")
    .map(([k, v]) => `  ${q(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}`);
  const makes = Object.keys(doc.names).sort(byCode).map((make) => {
    const models = Object.keys(doc.names[make]).sort(byCode)
      .map((model) => `      ${q(model)}: ${q(doc.names[make][model])}`);
    return `    ${q(make)}: {\n${models.join(",\n")}\n    }`;
  });
  return `{\n${[...head, `  "names": {\n${makes.join(",\n")}\n  }`].join(",\n")}\n}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      wikidata: { type: "string" },
      catmapping: { type: "string" },
    },
  });
  const [wikidata, catmapping] = await Promise.all([loadWikidata(values.wikidata), loadCatmapping(values.catmapping)]);
  const rows = wikidata?.results?.bindings?.length ?? 0;
  if (!rows) throw new Error("Wikidata returned no rows");

  const { names, conflicts, stats } = buildNames({ wikidata, catmapping });
  const doc = {
    about: "Camera display names by EXIF make and model, generated from CC0 sources. Regenerate with node apps/desktop/scripts/camera-names/build.mjs; review the diff.",
    license: "CC0 1.0",
    generated: new Date().toISOString().slice(0, 10),
    sources: SOURCES,
    names,
  };
  const text = serialize(doc);
  JSON.parse(text); // it is valid JSON, or this throws before the file is touched
  await writeFile(OUT, text);

  const kb = (Buffer.byteLength(text) / 1024).toFixed(0);
  console.log(`${OUT}\n  ${stats.entries} names, ${stats.perMake.length} makes, ${kb} KB (from ${rows} Wikidata rows)`);
  console.log("\nNames per make (top 30):");
  for (const [make, n] of stats.perMake.slice(0, 30)) console.log(`  ${String(n).padStart(5)}  ${make}`);
  console.log("\nDropped, by reason:");
  for (const [reason, n] of Object.entries(stats.droppedByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${reason}`);
  }
  if (stats.unusedCorrections.length) {
    console.log(`\nCorrections that no longer match an entry (remove them from corrections.mjs): ${stats.unusedCorrections.length}`);
    for (const key of stats.unusedCorrections) console.log(`  ${key}`);
  }
  console.log(`\nConflicts (dropped: one camera, several drones): ${conflicts.length}`);
  for (const c of conflicts) console.log(`  ${c.make} / ${c.model}: ${c.names.join(" | ")} (${c.items.join(", ")})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
