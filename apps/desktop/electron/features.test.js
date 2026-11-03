const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { loadManifests, loadFeatures, capabilitiesFromFeatures, registerFeatures, loadMcpToolGroups, FEATURES_DIR } = require("./features");

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

test("the real manifests: nothing off on a Mac with every helper; LUT and stickers off elsewhere", () => {
  assert.deepEqual(capabilitiesFromFeatures("darwin"), {});
  assert.deepEqual(capabilitiesFromFeatures("darwin", { hasHelper: (name) => name !== "extract-sticker" }), { stickerExtract: false });
  assert.deepEqual(capabilitiesFromFeatures("win32"), { lut: false, stickerExtract: false });
});

test("registerFeatures calls each entry's register(host) in manifest order", () => {
  const calls = [];
  const host = Object.freeze({ tag: "host" });
  const features = ["one", "two"].map((id) => ({ manifest: { id }, module: { register: (h) => calls.push([id, h]) } }));
  registerFeatures(host, features);
  assert.deepEqual(calls, [["one", host], ["two", host]]);
});

test("the manifests' MCP tool groups load by path and export (ctx) => tools[]", () => {
  const groups = loadMcpToolGroups();
  assert.equal(groups.length, loadManifests().filter((m) => m.contributes?.mcpTools).length);
  assert.ok(groups.length >= 1, "the repaint feature contributes repaint_asset");
  for (const group of groups) assert.equal(typeof group, "function");
  assert.deepEqual(loadMcpToolGroups([{ id: "lut", contributes: {} }]), []);
  const [repaint] = loadMcpToolGroups([{ id: "repaint", contributes: { mcpTools: "./electron/mcpTools.js" } }]);
  const tools = repaint({ deps: {}, commands: {}, requireCatalog: () => {} });
  assert.deepEqual(tools.map((t) => t.name), ["repaint_asset"]);
});

// Manifest v1 (features/manifestSchema.mjs): what the loader accepts.
const schema = require(path.join(FEATURES_DIR, "manifestSchema.mjs"));
const fs = require("node:fs");

// A valid manifest to break one field at a time.
function valid(overrides = {}) {
  return {
    manifestVersion: 1,
    id: "demo",
    capability: "lut",
    platforms: ["darwin"],
    helper: null,
    web: false,
    trust: "bundled",
    contributes: { editorTool: { key: "demo", labelKey: "overlay.tools.demo", unavailable: "locked" } },
    electron: "./electron/demo.js",
    ...overrides,
  };
}

test("manifest v1: the real manifests pass, and each has a directory under features/", () => {
  const manifests = loadManifests();
  assert.deepEqual(schema.validateManifests(manifests), manifests);
  for (const { id } of manifests) assert.ok(fs.existsSync(path.join(FEATURES_DIR, id, "manifest.mjs")), `features/${id}/manifest.mjs`);
});

test("manifest v1: a wrong field is reported by name", () => {
  const problem = (overrides) => schema.validateManifest(valid(overrides)).join("\n");
  assert.deepEqual(schema.validateManifest(valid()), []);
  assert.match(problem({ manifestVersion: 2 }), /manifestVersion must be 1/);
  assert.match(problem({ extra: true }), /unknown field "extra"/);
  assert.match(problem({ id: "Demo Tool" }), /id must match/);
  assert.match(problem({ capability: "nope" }), /capability "nope" is not in shared\/capabilities\.mjs/);
  assert.match(problem({ platforms: [] }), /platforms is null/);
  assert.match(problem({ platforms: ["ios"] }), /unknown platform "ios"/);
  assert.match(problem({ platforms: ["darwin", "darwin"] }), /twice/);
  assert.match(problem({ helper: "bin/x" }), /helper is null or a native\/bin name/);
  assert.match(problem({ web: "yes" }), /web is a boolean/);
  assert.match(problem({ trust: "sandboxed" }), /trust "sandboxed" is not accepted/);
  assert.match(problem({ electron: "electron/demo.js" }), /electron is a path like/);
  assert.match(problem({ contributes: {} }), /contributes nothing/);
  assert.match(problem({ contributes: { toolbar: {} } }), /unknown contribution "toolbar"/);
  assert.match(problem({ contributes: { editorTool: { key: "x", labelKey: "k", unavailable: "gone" } } }), /editorTool.unavailable is one of locked, hidden/);
  assert.match(problem({ contributes: { editorTool: { key: "x", labelKey: "k", unavailable: "locked", mount: "never" } } }), /editorTool.mount is one of active, always/);
  assert.match(problem({ contributes: { editorTool: { key: "x", labelKey: "k", unavailable: "locked", color: "red" } } }), /editorTool.color is not a field/);
  assert.match(problem({ contributes: { editorTool: { key: "x", unavailable: "locked" } } }), /editorTool.labelKey is a non-empty string/);
  assert.match(problem({ contributes: { settingsGroup: { tab: "general" } } }), /settingsGroup.tab is one of library/);
  assert.match(problem({ contributes: { settingsTab: { id: "x" } } }), /settingsTab.labelKey is a non-empty string/);
  assert.match(problem({ contributes: { sidebarView: { id: "x", labelKey: "k" } } }), /sidebarView.unavailable is one of/);
  assert.match(problem({ contributes: { layerSource: { id: "x", labelKey: "k" } } }), /layerSource.hideLabelKey is a non-empty string/);
  assert.match(problem({ contributes: { ipc: [] } }), /ipc is a non-empty array/);
  assert.match(problem({ contributes: { ipc: [["a", "b"]] } }), /ipc\[0\] is \[method, channel, arity\]/);
  assert.match(problem({ contributes: { ipc: [["List", "app:x", 0]] } }), /ipc\[0\] method must match/);
  assert.match(problem({ contributes: { ipc: [["list", "app_x", 0]] } }), /ipc\[0\] channel must match/);
  assert.match(problem({ contributes: { ipc: [["list", "app:x", 4]] } }), /ipc\[0\] arity is an integer 0–3/);
  assert.match(problem({ contributes: { ipc: [["list", "app:x", 0]] }, electron: undefined }), /ipc rows need an electron entry/);
  assert.match(problem({ contributes: { mcpTools: "mcpTools.js" } }), /mcpTools is a path like/);
  assert.deepEqual(schema.validateManifest(null), ["a manifest is an object"]);
});

test("manifest v1: what must be unique across manifests", () => {
  const a = valid({ id: "a", contributes: { editorTool: { key: "t", labelKey: "k", unavailable: "locked" }, ipc: [["m", "app:m", 0]] } });
  const b = valid({ id: "b", capability: "aiRepaint", contributes: { editorTool: { key: "t", labelKey: "k", unavailable: "locked" }, ipc: [["m", "app:n", 0]] } });
  assert.throws(() => schema.validateManifests([a, b]), (error) => {
    assert.match(error.message, /not valid v1/);
    assert.match(error.message, /b: editorTool.key "t" is also a's/);
    assert.match(error.message, /b: ipc method "m" is also a's/);
    assert.doesNotMatch(error.message, /ipc channel/);
    return true;
  });
  assert.throws(() => schema.validateManifests([a, { ...a }]), /a: id "a" is also a's[\s\S]*a: capability "lut" is also a's/);
  assert.throws(() => schema.validateManifests([valid({ id: "a" }), valid({ id: "b" })]), /b: capability "lut" is also a's/);
  assert.throws(() => schema.validateManifests({}), /the manifest list is an array/);
  const fine = [a, { ...b, contributes: { settingsTab: { id: "b", labelKey: "b:tab" } } }];
  assert.equal(schema.validateManifests(fine), fine);
});

test("manifest v1: the renderer exports each contribution needs", () => {
  assert.deepEqual(schema.rendererExportsFor(valid()), ["Panel", "icon"]);
  assert.deepEqual(schema.rendererExportsFor(valid({ contributes: { editorTool: { key: "x", labelKey: "k", unavailable: "locked", overlay: true } } })), ["Panel", "icon", "Overlay"]);
  assert.deepEqual(schema.rendererExportsFor(valid({ contributes: { settingsGroup: { tab: "library" }, settingsTab: { id: "x", labelKey: "x:tab" } } })), ["SettingsGroup", "SettingsTab", "settingsTabIcon"]);
  assert.deepEqual(schema.rendererExportsFor(valid({ contributes: { sidebarView: { id: "v", labelKey: "k", unavailable: "locked" }, layerSource: { id: "v", labelKey: "k", hideLabelKey: "h" } } })), ["View", "Inspector", "useView", "sidebarIcon", "layerSource"]);
  assert.deepEqual(schema.rendererExportsFor(valid({ contributes: { ipc: [["m", "app:m", 0]], mcpTools: "./electron/t.js" } })), []);
});
