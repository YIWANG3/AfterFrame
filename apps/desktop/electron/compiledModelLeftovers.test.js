const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MODEL_NAMES, MIN_AGE_MS, coreMLTempDir, removeLeftoverCompiledModels } = require("./compiledModelLeftovers");

const UUID = "1D154A23-CABD-435F-9F55-D328E959A47A";
const HOUR = 60 * 60 * 1000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-leftovers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A compiled model as Core ML writes one, last changed `ageMs` ago.
function compiled(dir, name, ageMs) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.join(target, "model.mil"), { recursive: true });
  fs.writeFileSync(path.join(target, "coremldata.bin"), "x");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
  return target;
}

test("the names are those of the models the app ships", async () => {
  const { MODELS } = await import("../scripts/bundled-models.mjs");
  assert.deepEqual([...MODEL_NAMES].sort(), MODELS.map((model) => path.basename(model.target, ".mlpackage")).sort());
});

test("old copies of the bundled models go; everything else stays", async (t) => {
  const dir = tempDir(t);
  const gone = [
    compiled(dir, `FaceEmbedding_${UUID}.mlmodelc`, 2 * HOUR),
    compiled(dir, "PetEmbedding_0BCF0286-EBB4-0D68-AB86-CCEB28FDAAA9.mlmodelc", 30 * HOUR),
    compiled(dir, "DepthAnythingV2SmallF16_9FEC1C43-D9D5-76BC-3B09-A95DBD08B3FF.mlmodelc", 300 * HOUR),
  ];
  const kept = [
    // Compiling now, or about to load.
    compiled(dir, "FaceEmbedding_C6AA27F4-DA05-A312-4C18-26A9F60FF31C.mlmodelc", MIN_AGE_MS / 2),
    // Another app's model, and copies compiled by hand without Core ML's suffix.
    compiled(dir, `OtherModel_${UUID}.mlmodelc`, 2 * HOUR),
    compiled(dir, "FaceEmbedding.mlmodelc", 2 * HOUR),
    compiled(dir, "FaceEmbedding_not-a-uuid.mlmodelc", 2 * HOUR),
    compiled(dir, `FaceEmbedding_${UUID}.mlpackage`, 2 * HOUR),
  ];
  const file = path.join(dir, `PetEmbedding_${UUID}.mlmodelc.tmp`);
  fs.writeFileSync(file, "");

  const removed = await removeLeftoverCompiledModels({ dir });

  assert.deepEqual(removed.sort(), gone.map((target) => path.basename(target)).sort());
  for (const target of gone) assert.equal(fs.existsSync(target), false, target);
  for (const target of [...kept, file]) assert.equal(fs.existsSync(target), true, target);
});

test("a file or a link with a leftover's name is left alone, and so is where the link points", async (t) => {
  const dir = tempDir(t);
  const elsewhere = compiled(tempDir(t), "Keep.mlmodelc", 2 * HOUR);
  const link = path.join(dir, `FaceEmbedding_${UUID}.mlmodelc`);
  fs.symlinkSync(elsewhere, link);
  const file = path.join(dir, "PetEmbedding_0BCF0286-EBB4-0D68-AB86-CCEB28FDAAA9.mlmodelc");
  fs.writeFileSync(file, "");
  const old = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(file, old, old);

  assert.deepEqual(await removeLeftoverCompiledModels({ dir }), []);
  assert.equal(fs.existsSync(link), true);
  assert.equal(fs.existsSync(path.join(elsewhere, "coremldata.bin")), true);
  assert.equal(fs.existsSync(file), true);
});

test("a folder that can't be read is no error", async (t) => {
  assert.deepEqual(await removeLeftoverCompiledModels({ dir: path.join(tempDir(t), "missing") }), []);
});

test("Core ML's folder is the one macOS gives the user", { skip: process.platform !== "darwin" }, async () => {
  const dir = await coreMLTempDir();
  assert.ok(path.isAbsolute(dir));
  assert.equal(fs.statSync(dir).isDirectory(), true);
});
