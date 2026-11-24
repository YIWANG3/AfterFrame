import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { MODELS, MODELS_RELEASE, archiveName } from "./bundled-models.mjs";
import { installModel } from "./fetch-models.mjs";
import { fileSha256 } from "./lib/download.mjs";

const require = createRequire(import.meta.url);
const { BUNDLED_ARCFACE_R100, pathDigest } = require("../electron/peopleModel.js");
const { BUNDLED_DINOV2_SMALL } = require("../electron/petModel.js");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-fetch-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("every bundled model is pinned and comes from the models release first", () => {
  const hex64 = /^[0-9a-f]{64}$/;
  for (const model of MODELS) {
    assert.ok(model.url.startsWith(`${MODELS_RELEASE}/`), `${model.id} downloads from the models release`);
    for (const url of model.fallbackUrls || []) assert.equal(new URL(url).protocol, "https:");
    assert.match(model.sha256, hex64);
    assert.match(model.dirHash, hex64);
    assert.ok(Number.isInteger(model.bytes) && model.bytes > 0);
    assert.match(model.target, /^[A-Za-z0-9]+\.mlpackage$/);
    assert.ok(model.license && model.missing);
  }
  for (const key of ["id", "target"]) {
    assert.equal(new Set(MODELS.map((model) => model[key])).size, MODELS.length, `${key}s are unique`);
  }
  assert.equal(new Set(MODELS.map(archiveName)).size, MODELS.length, "archive names are unique");
  // The app keys face and pet indexes by these: the build has to fetch exactly them.
  const face = MODELS.find((model) => model.id === "face");
  assert.equal(face.dirHash, BUNDLED_ARCFACE_R100.manifest_hash);
  assert.equal(face.target, BUNDLED_ARCFACE_R100.model_path);
  const pet = MODELS.find((model) => model.id === "pet");
  assert.equal(pet.dirHash, BUNDLED_DINOV2_SMALL.manifest_hash);
  assert.equal(pet.target, BUNDLED_DINOV2_SMALL.model_path);
  assert.equal(archiveName(pet), "PetEmbedding-dinov2-small-846f00a0.mlpackage.tar.gz");
});

// A tiny model package and its archive, as the release would hold them.
async function fakeModel(dir, { extra = false } = {}) {
  const source = path.join(dir, "source");
  const pkg = path.join(source, "Fake.mlpackage");
  fs.mkdirSync(path.join(pkg, "Data"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "Manifest.json"), "{}");
  fs.writeFileSync(path.join(pkg, "Data", "weights.bin"), "weights");
  if (extra) fs.writeFileSync(path.join(source, "stray.txt"), "x");
  const archive = path.join(dir, extra ? "stray.tar.gz" : "fake.tar.gz");
  // COPYFILE_DISABLE: macOS tar would otherwise add ._ files for extended attributes.
  execFileSync("tar", ["-czf", archive, "-C", source, ...(extra ? ["Fake.mlpackage", "stray.txt"] : ["Fake.mlpackage"])], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const model = {
    id: "fake",
    url: "https://release.test/models/Fake-1.mlpackage.tar.gz",
    fallbackUrls: ["https://mirror.test/Fake.mlpackage.tar.gz"],
    sha256: await fileSha256(archive),
    bytes: fs.statSync(archive).size,
    target: "Fake.mlpackage",
    dirHash: (await pathDigest(pkg)).sha256,
  };
  return { model, archive };
}

function fakeFetch(archive, { failing = [] } = {}) {
  const calls = [];
  const fetch = async (url, destination) => {
    calls.push(url);
    if (failing.includes(new URL(url).host)) throw new Error("HTTP 503");
    fs.copyFileSync(archive, destination);
  };
  return { fetch, calls };
}

test("installModel falls back when the release fails, caches the archive under its release name, then leaves a good copy alone", async (t) => {
  const dir = scratch(t);
  const nativeDir = path.join(dir, "native");
  const { model, archive } = await fakeModel(dir);
  const { fetch, calls } = fakeFetch(archive, { failing: ["release.test"] });

  await installModel(model, { nativeDir, fetch });
  assert.deepEqual(calls, [model.url, model.fallbackUrls[0]]);
  assert.equal((await pathDigest(path.join(nativeDir, "Fake.mlpackage"))).sha256, model.dirHash);
  assert.ok(fs.existsSync(path.join(nativeDir, ".cache", "Fake-1.mlpackage.tar.gz")));
  assert.deepEqual(fs.readdirSync(nativeDir).sort(), [".cache", "Fake.mlpackage"], "no staging left behind");

  await installModel(model, { nativeDir, fetch });
  assert.equal(calls.length, 2, "a model in place with the right hash is not fetched again");

  fs.writeFileSync(path.join(nativeDir, "Fake.mlpackage", "Manifest.json"), "changed");
  await installModel(model, { nativeDir, fetch });
  assert.equal(calls.length, 2, "an altered copy is replaced from the cached archive");
  assert.equal((await pathDigest(path.join(nativeDir, "Fake.mlpackage"))).sha256, model.dirHash);
});

test("installModel tries the fallback when the release serves other bytes", async (t) => {
  const dir = scratch(t);
  const nativeDir = path.join(dir, "native");
  const { model, archive } = await fakeModel(dir);
  const calls = [];
  const fetch = async (url, destination) => {
    calls.push(new URL(url).host);
    if (url === model.url) fs.writeFileSync(destination, "not the archive");
    else fs.copyFileSync(archive, destination);
  };
  await installModel(model, { nativeDir, fetch });
  assert.deepEqual(calls, ["release.test", "mirror.test"]);
  assert.ok(fs.existsSync(path.join(nativeDir, "Fake.mlpackage", "Manifest.json")));
});

test("installModel refuses an archive with anything beside the model, or with the wrong contents", async (t) => {
  const dir = scratch(t);
  const nativeDir = path.join(dir, "native");
  const stray = await fakeModel(path.join(dir, "a"), { extra: true });
  await assert.rejects(installModel(stray.model, { nativeDir, fetch: fakeFetch(stray.archive).fetch }), /holds more than Fake\.mlpackage/);

  const { model, archive } = await fakeModel(path.join(dir, "b"));
  await assert.rejects(
    installModel({ ...model, dirHash: "0".repeat(64) }, { nativeDir, fetch: fakeFetch(archive).fetch }),
    /unpacked Fake\.mlpackage hash is/,
  );
  assert.equal(fs.existsSync(path.join(nativeDir, "Fake.mlpackage")), false);
});

test("installModel removes a model whose self-test fails, and skips the test when the helper isn't built", async (t) => {
  const dir = scratch(t);
  const nativeDir = path.join(dir, "native");
  const { model, archive } = await fakeModel(dir);
  const { fetch } = fakeFetch(archive);
  const seen = [];
  const failing = { ...model, selfTest: { tool: "fake-tool", check: (tool, target) => { seen.push([tool, target]); throw new Error("self-test failed"); } } };

  await installModel(failing, { nativeDir, fetch });
  assert.deepEqual(seen, [], "no helper built: no self-test");

  fs.rmSync(path.join(nativeDir, "Fake.mlpackage"), { recursive: true });
  fs.mkdirSync(path.join(nativeDir, "bin"));
  fs.writeFileSync(path.join(nativeDir, "bin", "fake-tool"), "");
  await assert.rejects(installModel(failing, { nativeDir, fetch }), /self-test failed/);
  assert.deepEqual(seen, [[path.join(nativeDir, "bin", "fake-tool"), path.join(nativeDir, "Fake.mlpackage")]]);
  assert.equal(fs.existsSync(path.join(nativeDir, "Fake.mlpackage")), false);
  assert.deepEqual(fs.readdirSync(path.join(nativeDir, ".cache")).filter((name) => name.startsWith("self-test-")), [], "self-test scratch removed");
});
