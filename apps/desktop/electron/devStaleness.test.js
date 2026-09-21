const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { changedSince } = require("./devStaleness");

function touch(file, whenMs, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, whenMs / 1000, whenMs / 1000);
}

test("sources edited after the process started make it stale; older ones do not", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = Date.now();
  touch(path.join(root, "electron", "main.js"), started - 60_000);
  touch(path.join(root, "sidecar", "cli.py"), started - 60_000);
  assert.deepEqual(changedSince([root], started), { stale: false, count: 0, files: [] });

  touch(path.join(root, "sidecar", "cli.py"), started + 5_000);
  touch(path.join(root, "electron", "ipc", "collections.js"), started + 9_000);
  const result = changedSince([root], started);
  assert.equal(result.stale, true);
  assert.equal(result.count, 2);
  // Newest first: the file that most recently moved on is the one to name.
  assert.deepEqual(result.files.map((f) => path.basename(f)), ["collections.js", "cli.py"]);
});

test("tests, dependencies, caches and non-source files never count", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = Date.now();
  const later = started + 5_000;
  touch(path.join(root, "electron", "tokens.test.js"), later);
  touch(path.join(root, "node_modules", "pkg", "index.js"), later);
  touch(path.join(root, "sidecar", "__pycache__", "cli.cpython-312.pyc"), later);
  touch(path.join(root, "sidecar", "data", "gazetteer.json.gz"), later);
  touch(path.join(root, "electron", "notes.md"), later);
  assert.equal(changedSince([root], started).stale, false);
});

test("a missing root is not an error, and the list is capped", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = Date.now();
  for (let i = 0; i < 8; i += 1) touch(path.join(root, `m${i}.js`), started + 1_000 + i);
  const result = changedSince([path.join(root, "nope"), root], started, 3);
  assert.equal(result.count, 8);
  assert.equal(result.files.length, 3);
});

test("the restart exit code matches the dev wrapper's", () => {
  const wrapper = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev-electron.mjs"), "utf8");
  const declared = Number(/RESTART_CODE = (\d+)/.exec(wrapper)[1]);
  assert.equal(require("./devStaleness").DEV_RESTART_EXIT_CODE, declared);
});
