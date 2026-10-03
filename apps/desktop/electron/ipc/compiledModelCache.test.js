const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCompiledModelCache } = require("./compiledModelCache");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-compiled-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeModel(root, name) {
  const model = path.join(root, name);
  fs.mkdirSync(model, { recursive: true });
  fs.writeFileSync(path.join(model, "Manifest.json"), "{}");
  return model;
}

test("an already compiled model gets no cache path", (t) => {
  const root = tempDir(t);
  const cache = createCompiledModelCache({ dir: path.join(root, "cache"), appVersion: "1.0.0" });
  assert.equal(cache.pathFor(fakeModel(root, "Custom.mlmodelc")), null);
  assert.equal(cache.pathFor(fakeModel(root, "Custom.MLMODELC")), null);
});

test("the cache path is stable, and moves with the app version and the model's mtime", (t) => {
  const root = tempDir(t);
  const dir = path.join(root, "cache");
  const model = fakeModel(root, "Depth.mlpackage");
  const v1 = createCompiledModelCache({ dir, appVersion: "1.0.0" });

  const first = v1.pathFor(model);
  assert.equal(path.dirname(first), dir);
  assert.match(path.basename(first), /^[0-9a-f]{40}\.mlmodelc$/);
  assert.equal(v1.pathFor(model), first);

  assert.notEqual(createCompiledModelCache({ dir, appVersion: "1.0.1" }).pathFor(model), first);

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(model, later, later);
  assert.notEqual(v1.pathFor(model), first);
});

test("pruning keeps the current model and its staging copy, drops the rest", (t) => {
  const root = tempDir(t);
  const dir = path.join(root, "cache");
  const cache = createCompiledModelCache({ dir, appVersion: "1.0.0" });
  const keep = cache.pathFor(fakeModel(root, "Depth.mlpackage"));
  const key = path.basename(keep, ".mlmodelc");
  fs.mkdirSync(keep, { recursive: true });
  fs.mkdirSync(path.join(dir, `.${key}.mlmodelc.4242`));
  fs.mkdirSync(path.join(dir, `${"0".repeat(40)}.mlmodelc`));
  fs.writeFileSync(path.join(dir, "stray.tmp"), "");

  cache.pruneExcept(keep);

  assert.deepEqual(fs.readdirSync(dir).sort(), [`.${key}.mlmodelc.4242`, `${key}.mlmodelc`].sort());
});

test("pruning a cache that does not exist yet is a no-op", (t) => {
  const root = tempDir(t);
  const cache = createCompiledModelCache({ dir: path.join(root, "missing"), appVersion: "1.0.0" });
  assert.doesNotThrow(() => cache.pruneExcept(path.join(root, "missing", "x.mlmodelc")));
});
