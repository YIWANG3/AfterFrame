// The renderer reaches the outside world through three hand-maintained lists
// that nothing else keeps aligned:
//   electron/preload.js        what the desktop bridge exposes
//   src/api/index.js           the facade every component calls (its header:
//                              "New preload methods MUST be added here")
//   src/api/browser/bridge.js  the web build's in-browser implementation
// A method added to one and forgotten in another fails silently — invoke()
// returns undefined for an unknown name. Parsed as text on purpose: preload
// requires electron and the bridge assumes a browser, so neither imports here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Values (read by the facade's getters) and facade-only conveniences — not
// callable bridge methods, so they sit outside the parity comparison.
const PRELOAD_META = new Set(["isPackaged"]);
const FACADE_META = new Set(["isPackaged", "has", "capabilities", "can"]);
const BRIDGE_META = new Set(["isPackaged", "capabilities"]);

function keysOfObjectLiteral(source, openMarker) {
  const start = source.indexOf(openMarker);
  if (start < 0) throw new Error(`marker not found: ${openMarker}`);
  const body = source.slice(start + openMarker.length);
  const keys = new Set();
  for (const line of body.split("\n")) {
    if (/^\}[);]/.test(line)) break;                       // end of the top-level literal
    const m = /^ {2}(?:get |async )?([A-Za-z_$][\w$]*)\s*[:(]/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const preloadAll = keysOfObjectLiteral(read("../../electron/preload.js"), 'contextBridge.exposeInMainWorld("mediaWorkspace", {');
const preload = new Set([...preloadAll].filter((k) => !PRELOAD_META.has(k)));
const facade = keysOfObjectLiteral(read("./index.js"), "const api = {");
const bridge = keysOfObjectLiteral(read("./browser/bridge.js"), "export const browserBridge = {");

const facadeMethods = new Set([...facade].filter((k) => !FACADE_META.has(k)));
const bridgeMethods = new Set([...bridge].filter((k) => !BRIDGE_META.has(k)));
const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();

describe("API surface parity", () => {
  it("parsed something real from all three files", () => {
    // A regex that silently matched nothing would make every check below pass.
    expect(preload.size).toBeGreaterThan(100);
    expect(facadeMethods.size).toBeGreaterThan(100);
    expect(bridgeMethods.size).toBeGreaterThan(50);
  });

  it("every preload method has a facade entry, and the facade names nothing preload lacks", () => {
    expect(diff(preload, facadeMethods), "in preload.js but missing from src/api/index.js").toEqual([]);
    expect(diff(facadeMethods, preload), "in src/api/index.js but not exposed by preload.js").toEqual([]);
  });

  it("the web bridge only implements names the facade can call (subset — gaps are declared via capabilities)", () => {
    expect(diff(bridgeMethods, facadeMethods), "in browser/bridge.js but not a facade method (renamed or misspelled?)").toEqual([]);
  });
});
