// shared/capabilities.mjs is the one list of features a bridge can turn off.
// Its names are strings at every use, so a misspelt check or a flag nothing
// reads fails silently: api.can("lutt") is simply always true. This reads the
// renderer's sources and the web bridge as text and holds them to the list.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_NAMES } from "../../shared/capabilities.mjs";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name) ? [file] : [];
  });
}

// api.can("name"), and the tables whose entries the UI hands to api.can():
// `cap: "name"` (Settings tabs, toolbar menu), `capability: "name"` (filter bar).
// Names are identifiers: a `capability: "Image repaint"` is a provider card's
// text (components/ai/providers.jsx), not a flag.
const CHECKED = [/\bapi\.can\(\s*"([^"]+)"/g, /\bcap:\s*"([A-Za-z]+)"/g, /\bcapability:\s*"([A-Za-z]+)"/g];

const checked = new Map(); // name → files
for (const file of sources(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const pattern of CHECKED) {
    for (const [, name] of text.matchAll(pattern)) {
      checked.set(name, [...(checked.get(name) || []), file.slice(SRC.length)]);
    }
  }
}

function webCapabilities() {
  const text = readFileSync(join(SRC, "api/browser/bridge.js"), "utf8");
  const block = /\n {2}capabilities: \{\n([\s\S]*?)\n {2}\},/.exec(text);
  if (!block) throw new Error("capabilities block not found in src/api/browser/bridge.js");
  return Object.fromEntries([...block[1].matchAll(/^ {4}(\w+): (\w+)/gm)].map(([, name, value]) => [name, value]));
}

describe("feature flags (shared/capabilities.mjs)", () => {
  it("every flag the UI checks is a feature on the list", () => {
    const unknown = [...checked].filter(([name]) => !FEATURE_NAMES.includes(name));
    expect(unknown, "checked but not in shared/capabilities.mjs (misspelt, or add it)").toEqual([]);
  });

  it("every feature on the list is checked somewhere", () => {
    expect(FEATURE_NAMES.filter((name) => !checked.has(name)), "listed but nothing checks it").toEqual([]);
  });

  it("the web bridge declares only features on the list, and says what it lacks", () => {
    const declared = webCapabilities();
    expect(Object.keys(declared).filter((name) => name !== "web" && !FEATURE_NAMES.includes(name)), "not a feature").toEqual([]);
    expect(declared.web).toBe("true");
    // The browser has no LUT library: declared, not left to a missing method.
    expect(declared.lut).toBe("false");
  });
});
