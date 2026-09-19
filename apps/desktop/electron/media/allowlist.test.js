const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createMediaAllowlist } = require("./allowlist");

// No disk: realpath maps /tmp → /private/tmp like macOS, everything else is
// its own canonical form; roots are files unless listed as directories.
function harness({ catalog = "/tmp/lib.afcatalog", roots = [], dirs = [] } = {}) {
  let loads = 0;
  const gate = createMediaAllowlist({
    getCatalogPath: () => catalog,
    catalogHasDb: () => true,
    loadCatalogRoots: async () => { loads += 1; return roots.map((p) => ({ path: p })); },
    realpath: (p) => p.replace(/^\/tmp(\/|$)/, "/private/tmp$1"),
    isDirectory: (p) => dirs.includes(p),
  });
  return { gate, loads: () => loads };
}

test("the catalog tree is always allowed, through symlinked spellings too", () => {
  const { gate } = harness();
  assert.equal(gate.isAllowedMediaPath("/tmp/lib.afcatalog/previews/a.jpg"), true);
  assert.equal(gate.isAllowedMediaPath("/private/tmp/lib.afcatalog/previews/a.jpg"), true, "sidecar emits realpath'd paths");
  assert.equal(gate.isAllowedMediaPath("/tmp/lib.afcatalog-other/a.jpg"), false, "prefix must end at a separator");
  assert.equal(gate.isAllowedMediaPath("/Users/x/Documents/a.jpg"), false);
});

test("a file root also allows its directory; loading happens once per catalog", async () => {
  const { gate, loads } = harness({ roots: ["/photos/one.jpg", "/exports"], dirs: ["/exports"] });
  assert.equal(gate.isAllowedMediaPath("/photos/one-edit.jpg"), false, "before roots load");
  assert.equal(await gate.isAllowedMediaPathLoaded("/photos/one-edit.jpg"), true, "sibling derivative next to a per-file root");
  assert.equal(await gate.isAllowedMediaPathLoaded("/exports/sub/x.jpg"), true);
  assert.equal(await gate.isAllowedMediaPathLoaded("/elsewhere/x.jpg"), false);
  assert.equal(loads(), 1);
});

test("reset drops catalog roots but keeps baseline dirs", async () => {
  const { gate, loads } = harness({ roots: ["/photos"], dirs: ["/photos"] });
  gate.addBaselineMediaDir("/Users/x/Library/afterframe");
  await gate.ensureMediaRootsLoaded();
  assert.equal(gate.isAllowedMediaPath("/photos/a.jpg"), true);
  gate.resetMediaAllowlist();
  assert.equal(gate.isAllowedMediaPath("/photos/a.jpg"), false, "previous catalog's roots are gone");
  assert.equal(gate.isAllowedMediaPath(path.join("/Users/x/Library/afterframe", "stickers", "s.png")), true);
  await gate.ensureMediaRootsLoaded();
  assert.equal(loads(), 2, "roots reload lazily for the next catalog");
});

test("a failed roots load is retried on the next request", async () => {
  let fail = true;
  const gate = createMediaAllowlist({
    getCatalogPath: () => "/c", catalogHasDb: () => true,
    loadCatalogRoots: async () => { if (fail) throw new Error("sidecar down"); return [{ path: "/photos" }]; },
    realpath: (p) => p, isDirectory: () => true,
  });
  assert.equal(await gate.isAllowedMediaPathLoaded("/photos/a.jpg"), false);
  fail = false;
  assert.equal(await gate.isAllowedMediaPathLoaded("/photos/a.jpg"), true);
});
