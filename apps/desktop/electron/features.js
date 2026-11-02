// The main process's side of the feature modules (features/README.md): read
// the manifests, load each feature's main-process entry, register them with
// the host, and tell the renderer which features this build lacks.
//
// A manifest is pure data; its `electron` field names the entry file relative
// to the manifest, and that file exports register(host) like every module in
// electron/ipc/. A manifest without `electron` (a sandboxed plugin, one day)
// has nothing to run here.
const path = require("node:path");

const FEATURES_DIR = path.join(__dirname, "..", "features");

function loadManifests() {
  return require(path.join(FEATURES_DIR, "manifests.mjs")).default;
}

function loadFeatures(manifests = loadManifests()) {
  return manifests
    .filter((manifest) => manifest.electron)
    .map((manifest) => ({ manifest, module: require(path.join(FEATURES_DIR, manifest.id, manifest.electron)) }));
}

// The capability flags the manifests turn off for this build: a feature whose
// `platforms` leave this one out, or whose `helper` is not in native/bin,
// declares its capability false (shared/capabilities.mjs: undeclared means
// available). electron/capabilities.js merges this with the hand-written
// flags of the features that have not moved yet.
function capabilitiesFromFeatures(platform, { hasHelper = () => true } = {}, manifests = loadManifests()) {
  const off = {};
  for (const { capability, platforms, helper } of manifests) {
    if (!capability) continue;
    const onPlatform = !platforms || platforms.includes(platform);
    if (!onPlatform || (helper && !hasHelper(helper))) off[capability] = false;
  }
  return off;
}

function registerFeatures(host, features = loadFeatures()) {
  for (const { module } of features) module.register(host);
}

// The MCP tool groups the manifests contribute (`contributes.mcpTools`, a
// path relative to the manifest): each module exports (ctx) => tools[] like
// electron/mcp/tools/*.js, and mcp/tools/index.js appends them to its own.
function loadMcpToolGroups(manifests = loadManifests()) {
  return manifests
    .filter((manifest) => manifest.contributes?.mcpTools)
    .map((manifest) => require(path.join(FEATURES_DIR, manifest.id, manifest.contributes.mcpTools)));
}

module.exports = { FEATURES_DIR, loadManifests, loadFeatures, capabilitiesFromFeatures, registerFeatures, loadMcpToolGroups };
