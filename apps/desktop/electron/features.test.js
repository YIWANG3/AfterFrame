const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { loadManifests, loadFeatures, capabilitiesFromFeatures, registerFeatures, FEATURES_DIR } = require("./features");

test("every manifest's electron entry resolves to a module with register()", () => {
  const manifests = loadManifests();
  assert.ok(manifests.length >= 1, "features/manifests.mjs lists at least the lut feature");
  const features = loadFeatures();
  assert.deepEqual(features.map((f) => f.manifest.id), manifests.filter((m) => m.electron).map((m) => m.id));
  for (const { manifest, module } of features) {
    assert.equal(typeof module.register, "function", `${manifest.id}: ${manifest.electron} exports register`);
  }
  assert.equal(path.basename(FEATURES_DIR), "features");
});

test("a manifest without an electron entry is skipped, with one is required by its path", () => {
  const silent = { id: "silent", capability: "x" };
  assert.deepEqual(loadFeatures([silent]), []);
  const [lut] = loadFeatures([{ id: "lut", electron: "./electron/luts.js" }]);
  assert.equal(typeof lut.module.register, "function");
});

test("capabilities: off the manifest's platforms, or without its helper, the capability is false", () => {
  const manifests = [
    { id: "a", capability: "lut", platforms: ["darwin"], helper: null },
    { id: "b", capability: "stickerExtract", platforms: ["darwin"], helper: "extract-sticker" },
    { id: "c", capability: "everywhere", platforms: null, helper: null },
    { id: "d" /* no capability: never declared */, platforms: ["win32"] },
  ];
  const all = () => true;
  assert.deepEqual(capabilitiesFromFeatures("darwin", { hasHelper: all }, manifests), {});
  assert.deepEqual(capabilitiesFromFeatures("darwin", { hasHelper: (name) => name !== "extract-sticker" }, manifests), { stickerExtract: false });
  assert.deepEqual(capabilitiesFromFeatures("win32", { hasHelper: all }, manifests), { lut: false, stickerExtract: false });
  assert.deepEqual(capabilitiesFromFeatures("linux", {}, manifests), { lut: false, stickerExtract: false });
});

test("the lut manifest alone: false off macOS, nothing on it", () => {
  assert.deepEqual(capabilitiesFromFeatures("darwin"), {});
  assert.deepEqual(capabilitiesFromFeatures("win32"), { lut: false });
});

test("registerFeatures calls each entry's register(host) in manifest order", () => {
  const calls = [];
  const host = Object.freeze({ tag: "host" });
  const features = ["one", "two"].map((id) => ({ manifest: { id }, module: { register: (h) => calls.push([id, h]) } }));
  registerFeatures(host, features);
  assert.deepEqual(calls, [["one", host], ["two", host]]);
});
