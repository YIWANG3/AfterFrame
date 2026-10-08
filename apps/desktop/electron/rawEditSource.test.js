const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cacheName, fullRenderNeeded, pruneCache, readRenderer, writeRenderer } = require("./rawEditSource");

test("a RAW whose HD is the camera's smaller embedded JPEG gets a full render", () => {
  // Fuji GFX 100S: 4000×3000 embedded in 11648×8735.
  assert.equal(fullRenderNeeded({ width: 4000, height: 3000 }, { width: 11648, height: 8735 }), true);
  // Canon: the embedded JPEG is the full size, so the HD is enough.
  assert.equal(fullRenderNeeded({ width: 6720, height: 4480 }, { width: 6720, height: 4480 }), false);
  // Orientation and a renderer's extra row don't count.
  assert.equal(fullRenderNeeded({ width: 4480, height: 6720 }, { width: 6720, height: 4480 }), false);
  assert.equal(fullRenderNeeded({ width: 11648, height: 8736 }, { width: 11648, height: 8735 }), false);
  // Without the RAW's size there is nothing to compare: keep the HD.
  assert.equal(fullRenderNeeded({ width: 4000, height: 3000 }, {}), false);
});

test("a render belongs to one version of one file", () => {
  const name = cacheName("/p/a.RAF", { size: 10, mtimeMs: 1 });
  assert.match(name, /^[0-9a-f]{24}\.jpg$/);
  assert.equal(cacheName("/p/a.RAF", { size: 10, mtimeMs: 1 }), name);
  assert.notEqual(cacheName("/p/a.RAF", { size: 10, mtimeMs: 2 }), name);
  assert.notEqual(cacheName("/p/b.RAF", { size: 10, mtimeMs: 1 }), name);
});

test("a render remembers its renderer, and pruning drops the note with it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-edit-cache-"));
  try {
    const old = path.join(dir, "old.jpg");
    const fresh = path.join(dir, "fresh.jpg");
    for (const [file, i] of [[old, 0], [fresh, 1]]) {
      fs.writeFileSync(file, "x");
      const when = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(file, when, when);
    }
    writeRenderer(old, "libraw");
    writeRenderer(fresh, "image-io");
    assert.equal(readRenderer(fresh), "image-io");
    assert.equal(readRenderer(path.join(dir, "none.jpg")), null);
    pruneCache(dir, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["fresh.jpg", "fresh.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache keeps the most recently used renders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-edit-cache-"));
  try {
    for (let i = 0; i < 8; i += 1) {
      const file = path.join(dir, `r${i}.jpg`);
      fs.writeFileSync(file, "x");
      const when = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(file, when, when);
    }
    fs.writeFileSync(path.join(dir, ".r9.partial.jpg"), "x"); // a render in progress
    const removed = pruneCache(dir, 6).map((file) => path.basename(file)).sort();
    assert.deepEqual(removed, ["r0.jpg", "r1.jpg"]);
    assert.equal(fs.readdirSync(dir).length, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
