// Manifest v1: the shape of features/<id>/manifest.mjs, frozen once the three
// bundled features (LUT, AI Repaint, sticker) had settled it (2026-11-02,
// docs/feature-modules-plan.md §12; amended 2026-11-03 for the features'
// own i18n namespaces: every labelKey is "<namespace>:<key>", and
// settingsTab names its label with labelKey like the other contributions). features/manifests.mjs validates the
// list at import, so a wrong manifest stops both processes at startup
// with the field named instead of a contribution that silently never
// shows. features/README.md documents every field; a change to this file is
// a change to that contract: bump MANIFEST_VERSION, update the README and
// the plan, and say why.
//
// Pure data and checks: no imports beyond the shared capability list, so
// shared/ipcChannels.mjs and the preload's parity tests can keep importing
// the manifests.
import { FEATURE_NAMES } from "../shared/capabilities.mjs";

export const MANIFEST_VERSION = 1;

// Where a feature may declare itself available (`platforms`); null means everywhere.
export const PLATFORMS = ["darwin", "win32", "linux"];
// "bundled" is the first-party tier: in-tree, privileged (Node, helpers,
// sharp). The sandboxed third-party tier is not accepted yet; its manifests
// will come with a MANIFEST_VERSION bump.
export const TRUST_LEVELS = ["bundled"];
// What the UI does with a contribution whose capability is false.
export const UNAVAILABLE = ["locked", "hidden"];
// When an editor tool's panel is mounted: while the tool is active, or for
// the editor's whole life (EditorOverlay honours it by hand).
export const PANEL_MOUNT = ["active", "always"];
// The Settings tabs that render feature groups (LibrarySettings.jsx is the
// only one so far).
export const SETTINGS_GROUP_TABS = ["library"];
// IPC rows: [method, channel, arity], the shape of shared/ipcChannels.mjs.
export const IPC_MAX_ARITY = 3;

const IDENT = /^[a-z][a-z0-9-]*$/; // ids, keys, helper names
const METHOD = /^[a-z][A-Za-z0-9]*$/; // bridge method names (api.<method>)
const CHANNEL = /^[a-z]+:[a-z0-9-]+$/; // ipcMain channels
const ENTRY = /^\.\/.+\.js$/; // paths relative to the manifest

const TOP_LEVEL = ["manifestVersion", "id", "capability", "platforms", "helper", "web", "trust", "contributes", "electron"];
const CONTRIBUTIONS = ["editorTool", "settingsGroup", "settingsTab", "sidebarView", "layerSource", "ipc", "mcpTools"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;

// The problems with one manifest, each a sentence naming the field; [] when
// it is a valid v1 manifest.
export function validateManifest(manifest) {
  const problems = [];
  if (!isObject(manifest)) return ["a manifest is an object"];
  const who = isText(manifest.id) ? manifest.id : "(no id)";
  const bad = (message) => problems.push(`${who}: ${message}`);

  for (const key of Object.keys(manifest)) if (!TOP_LEVEL.includes(key)) bad(`unknown field "${key}" (manifest v1 has ${TOP_LEVEL.join(", ")})`);
  if (manifest.manifestVersion !== MANIFEST_VERSION) bad(`manifestVersion must be ${MANIFEST_VERSION}, got ${JSON.stringify(manifest.manifestVersion)}`);
  if (!isText(manifest.id) || !IDENT.test(manifest.id)) bad(`id must match ${IDENT}`);
  if (!FEATURE_NAMES.includes(manifest.capability)) bad(`capability ${JSON.stringify(manifest.capability)} is not in shared/capabilities.mjs`);
  if (manifest.platforms !== null) {
    const list = manifest.platforms;
    if (!Array.isArray(list) || list.length === 0) bad("platforms is null (everywhere) or a non-empty array");
    else {
      for (const p of list) if (!PLATFORMS.includes(p)) bad(`platforms: unknown platform ${JSON.stringify(p)} (${PLATFORMS.join(", ")})`);
      if (new Set(list).size !== list.length) bad("platforms lists a platform twice");
    }
  }
  if (manifest.helper !== null && (!isText(manifest.helper) || !IDENT.test(manifest.helper))) bad(`helper is null or a native/bin name matching ${IDENT}`);
  if (typeof manifest.web !== "boolean") bad("web is a boolean");
  if (!TRUST_LEVELS.includes(manifest.trust)) bad(`trust ${JSON.stringify(manifest.trust)} is not accepted (${TRUST_LEVELS.join(", ")})`);
  if (manifest.electron !== undefined && (!isText(manifest.electron) || !ENTRY.test(manifest.electron))) bad(`electron is a path like "./electron/x.js", relative to the manifest`);

  const contributes = manifest.contributes;
  if (!isObject(contributes)) {
    bad("contributes is an object");
    return problems;
  }
  const keys = Object.keys(contributes);
  if (keys.length === 0) bad("contributes nothing");
  for (const key of keys) if (!CONTRIBUTIONS.includes(key)) bad(`unknown contribution "${key}" (manifest v1 has ${CONTRIBUTIONS.join(", ")})`);

  const fields = (name, value, allowed, required) => {
    if (!isObject(value)) return bad(`${name} is an object`), false;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${name}.${key} is not a field (${allowed.join(", ")})`);
    for (const key of required) if (!isText(value[key])) bad(`${name}.${key} is a non-empty string`);
    return true;
  };

  const { editorTool, settingsGroup, settingsTab, sidebarView, layerSource, ipc, mcpTools } = contributes;
  if (editorTool !== undefined && fields("editorTool", editorTool, ["key", "labelKey", "unavailable", "overlay", "mount"], ["key", "labelKey"])) {
    if (isText(editorTool.key) && !IDENT.test(editorTool.key)) bad(`editorTool.key must match ${IDENT}`);
    if (!UNAVAILABLE.includes(editorTool.unavailable)) bad(`editorTool.unavailable is one of ${UNAVAILABLE.join(", ")}`);
    if (editorTool.overlay !== undefined && typeof editorTool.overlay !== "boolean") bad("editorTool.overlay is a boolean");
    if (editorTool.mount !== undefined && !PANEL_MOUNT.includes(editorTool.mount)) bad(`editorTool.mount is one of ${PANEL_MOUNT.join(", ")}`);
  }
  if (settingsGroup !== undefined && fields("settingsGroup", settingsGroup, ["tab"], ["tab"])) {
    if (!SETTINGS_GROUP_TABS.includes(settingsGroup.tab)) bad(`settingsGroup.tab is one of ${SETTINGS_GROUP_TABS.join(", ")}`);
  }
  if (settingsTab !== undefined && fields("settingsTab", settingsTab, ["id", "labelKey"], ["id", "labelKey"])) {
    if (isText(settingsTab.id) && !IDENT.test(settingsTab.id)) bad(`settingsTab.id must match ${IDENT}`);
  }
  if (sidebarView !== undefined && fields("sidebarView", sidebarView, ["id", "labelKey", "unavailable"], ["id", "labelKey"])) {
    if (isText(sidebarView.id) && !IDENT.test(sidebarView.id)) bad(`sidebarView.id must match ${IDENT}`);
    if (!UNAVAILABLE.includes(sidebarView.unavailable)) bad(`sidebarView.unavailable is one of ${UNAVAILABLE.join(", ")}`);
  }
  if (layerSource !== undefined && fields("layerSource", layerSource, ["id", "labelKey", "hideLabelKey"], ["id", "labelKey", "hideLabelKey"])) {
    if (isText(layerSource.id) && !IDENT.test(layerSource.id)) bad(`layerSource.id must match ${IDENT}`);
  }
  if (ipc !== undefined) {
    if (!Array.isArray(ipc) || ipc.length === 0) bad("ipc is a non-empty array of [method, channel, arity] rows");
    else {
      ipc.forEach((row, i) => {
        const name = `ipc[${i}]`;
        if (!Array.isArray(row) || row.length !== 3) return bad(`${name} is [method, channel, arity]`);
        const [method, channel, arity] = row;
        if (!isText(method) || !METHOD.test(method)) bad(`${name} method must match ${METHOD}`);
        if (!isText(channel) || !CHANNEL.test(channel)) bad(`${name} channel must match ${CHANNEL}`);
        if (!Number.isInteger(arity) || arity < 0 || arity > IPC_MAX_ARITY) bad(`${name} arity is an integer 0–${IPC_MAX_ARITY}`);
      });
      if (!manifest.electron) bad("ipc rows need an electron entry to answer them");
    }
  }
  if (mcpTools !== undefined) {
    if (!isText(mcpTools) || !ENTRY.test(mcpTools)) bad(`mcpTools is a path like "./electron/mcpTools.js", relative to the manifest`);
  }
  return problems;
}

// Validates each manifest and what must be unique across them; throws one
// Error listing every problem, else returns the list unchanged.
export function validateManifests(manifests) {
  if (!Array.isArray(manifests)) throw new Error("features/manifests.mjs: the manifest list is an array");
  const problems = manifests.flatMap(validateManifest);
  const unique = (what, pick) => {
    const seen = new Map();
    for (const manifest of manifests) {
      for (const value of pick(manifest) ?? []) {
        if (value === undefined) continue;
        if (seen.has(value)) problems.push(`${manifest.id}: ${what} ${JSON.stringify(value)} is also ${seen.get(value)}'s`);
        else seen.set(value, manifest.id);
      }
    }
  };
  unique("id", (m) => [m.id]);
  unique("capability", (m) => [m.capability]);
  unique("editorTool.key", (m) => [m.contributes?.editorTool?.key]);
  unique("settingsTab.id", (m) => [m.contributes?.settingsTab?.id]);
  unique("sidebarView.id", (m) => [m.contributes?.sidebarView?.id]);
  unique("layerSource.id", (m) => [m.contributes?.layerSource?.id]);
  unique("ipc method", (m) => (Array.isArray(m.contributes?.ipc) ? m.contributes.ipc.map((row) => row?.[0]) : []));
  unique("ipc channel", (m) => (Array.isArray(m.contributes?.ipc) ? m.contributes.ipc.map((row) => row?.[1]) : []));
  if (problems.length) throw new Error(`feature manifests are not valid v${MANIFEST_VERSION}:\n  ${problems.join("\n  ")}`);
  return manifests;
}

// What a manifest's contributions require of its renderer/index.js
// (features/index.js checks at startup). `useTool` is not required: a tool
// without state of its own (AI Repaint) has none, and EditorOverlay imports
// the hooks by name anyway.
export function rendererExportsFor(manifest) {
  const { editorTool, settingsGroup, settingsTab, sidebarView, layerSource } = manifest.contributes ?? {};
  return [
    ...(editorTool ? ["Panel", "icon", ...(editorTool.overlay ? ["Overlay"] : [])] : []),
    ...(settingsGroup ? ["SettingsGroup"] : []),
    ...(settingsTab ? ["SettingsTab", "settingsTabIcon"] : []),
    ...(sidebarView ? ["View", "Inspector", "useView", "sidebarIcon"] : []),
    ...(layerSource ? ["layerSource"] : []),
  ];
}
