// The caches under userData keep their most recently used entries within a
// budget and delete the rest (review 2026-11-27, disk growth).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pruneToBudget, touch } = require("./cacheBudget");

function cacheDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-cache-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A file of `bytes`, last used `secondsAgo`.
function entry(dir, name, bytes, secondsAgo) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const at = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, at, at);
  return file;
}

test("the least recently used go until the rest fit the budget", (t) => {
  const dir = cacheDir(t);
  const oldest = entry(dir, "a.mp4", 100, 30);
  const middle = entry(dir, "b.mp4", 100, 20);
  entry(dir, "c.mp4", 100, 10);
  assert.deepEqual(pruneToBudget(dir, 250), [oldest]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["b.mp4", "c.mp4"]);
  assert.deepEqual(pruneToBudget(dir, 100), [middle]);
  assert.deepEqual(pruneToBudget(dir, 100), [], "within the budget: nothing to delete");
});

test("an entry in keep stays even past the budget on its own; the older ones go", (t) => {
  const dir = cacheDir(t);
  const other = entry(dir, "small.mp4", 50, 20);
  const kept = entry(dir, "big.mp4", 300, 10);
  assert.deepEqual(pruneToBudget(dir, 100, { keep: [kept] }), [other]);
  assert.deepEqual(fs.readdirSync(dir), ["big.mp4"], "bigger than the whole budget, but the one just written");
});

test("a folder is one entry, sized by its files; dot names and what include leaves out are not entries", (t) => {
  const dir = cacheDir(t);
  const strip = path.join(dir, "strip-old");
  fs.mkdirSync(strip);
  for (const name of ["frame_0.jpg", "frame_1.jpg"]) fs.writeFileSync(path.join(strip, name), Buffer.alloc(100));
  const at = new Date(Date.now() - 30_000);
  fs.utimesSync(strip, at, at);
  entry(dir, "strip-new", 150, 10);
  entry(dir, ".partial.jpg", 10_000, 40);
  entry(dir, "notes.txt", 10_000, 50);
  assert.deepEqual(pruneToBudget(dir, 200, { include: (name) => name.startsWith("strip") }), [strip]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".partial.jpg", "notes.txt", "strip-new"]);
});

test("touch makes an entry the most recently used; a missing folder prunes nothing", (t) => {
  const dir = cacheDir(t);
  const replayed = entry(dir, "a.mp4", 100, 30);
  const other = entry(dir, "b.mp4", 100, 20);
  touch(replayed);
  assert.deepEqual(pruneToBudget(dir, 150), [other]);
  touch(path.join(dir, "gone.mp4"));
  assert.deepEqual(pruneToBudget(path.join(dir, "missing"), 0), []);
});
