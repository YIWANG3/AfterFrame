// The renderer reaches the outside world through one table and three files:
//   shared/ipcChannels.mjs     every request/response method (the table)
//   electron/preload.js        the table's bindings + hand-written extras
//   src/api/index.js           the facade: generated from the table + the
//                              same hand-written extras
//   src/api/browser/bridge.js  the web build's in-browser implementation
// A hand-written method added to one file and forgotten in another fails
// silently — invoke() returns undefined for an unknown name. The two Electron
// files are parsed as text on purpose: preload requires electron and the
// bridge assumes a browser, so neither imports here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IPC_METHODS, IPC_METHOD_NAMES } from "../../shared/ipcChannels.mjs";

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

const table = new Set(IPC_METHOD_NAMES);
const preloadHand = keysOfObjectLiteral(read("../../electron/preload.js"), 'contextBridge.exposeInMainWorld("mediaWorkspace", {');
const facadeHand = keysOfObjectLiteral(read("./index.js"), "const api = {");
const bridge = keysOfObjectLiteral(read("./browser/bridge.js"), "export const browserBridge = {");

const preload = new Set([...table, ...[...preloadHand].filter((k) => !PRELOAD_META.has(k))]);
const facadeMethods = new Set([...table, ...[...facadeHand].filter((k) => !FACADE_META.has(k))]);
const bridgeMethods = new Set([...bridge].filter((k) => !BRIDGE_META.has(k)));
const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();

describe("API surface parity", () => {
  it("parsed something real from every source", () => {
    // A regex that silently matched nothing would make every check below pass.
    expect(table.size).toBeGreaterThan(100);
    expect(preloadHand.size).toBeGreaterThan(5);
    expect(facadeHand.size).toBeGreaterThan(5);
    expect(bridgeMethods.size).toBeGreaterThan(50);
  });

  it("the table has no duplicate method or channel, and an arity for every row", () => {
    const channels = IPC_METHODS.map(([, channel]) => channel);
    expect(new Set(IPC_METHOD_NAMES).size).toBe(IPC_METHODS.length);
    expect(new Set(channels).size).toBe(IPC_METHODS.length);
    for (const row of IPC_METHODS) expect(row, `${row[0]}: [method, channel, arity]`).toHaveLength(3);
    for (const [method, , arity] of IPC_METHODS) expect(Number.isInteger(arity) && arity >= 0, `${method}: arity`).toBe(true);
  });

  it("nothing hand-written duplicates a table row (the spread would be silently overridden)", () => {
    expect([...preloadHand].filter((k) => table.has(k)), "hand-written in preload.js AND in the table").toEqual([]);
    expect([...facadeHand].filter((k) => table.has(k)), "hand-written in src/api/index.js AND in the table").toEqual([]);
  });

  it("every preload method has a facade entry, and the facade names nothing preload lacks", () => {
    expect(diff(preload, facadeMethods), "in preload.js but missing from src/api/index.js").toEqual([]);
    expect(diff(facadeMethods, preload), "in src/api/index.js but not exposed by preload.js").toEqual([]);
  });

  it("the web bridge only implements names the facade can call (subset — gaps are declared via capabilities)", () => {
    expect(diff(bridgeMethods, facadeMethods), "in browser/bridge.js but not a facade method (renamed or misspelled?)").toEqual([]);
  });
});
