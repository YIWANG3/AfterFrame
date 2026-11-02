// The renderer's registry of feature modules: each manifest's id to what its
// renderer/index.js exports (Panel, useTool, SettingsGroup, SettingsTab, icon,
// …), and the tables the host UI reads from the manifests — the tool-rail
// rows, the Settings groups and tabs. Hooks are not called from here:
// EditorOverlay imports a feature's hooks itself (rules of hooks), see
// docs/feature-modules-plan.md §6.
import manifests from "./manifests.mjs";
import * as lut from "./lut/renderer/index.js";
import * as repaint from "./repaint/renderer/index.js";

export const FEATURES = { lut, repaint };

for (const manifest of manifests) {
  if (!FEATURES[manifest.id]) throw new Error(`features/index.js: no renderer registered for the "${manifest.id}" manifest`);
}

// Rows for src/components/editor/editorTools.js, in manifest order; that file
// decides where on the rail each one sits.
export const editorToolFeatures = manifests
  .filter((manifest) => manifest.contributes?.editorTool)
  .map(({ id, capability, contributes: { editorTool } }) => ({
    key: editorTool.key,
    icon: FEATURES[id].icon,
    labelKey: editorTool.labelKey,
    cap: capability,
    unavailable: editorTool.unavailable,
  }));

// The tabs feature modules add to Settings (SettingsOverlay.jsx places them),
// each gated by its feature's capability like the core tabs.
export const settingsTabs = manifests
  .filter((manifest) => manifest.contributes?.settingsTab)
  .map(({ id, capability, contributes: { settingsTab } }) => ({
    id: settingsTab.id,
    key: settingsTab.key,
    icon: FEATURES[id].settingsTabIcon,
    cap: capability,
    Pane: FEATURES[id].SettingsTab,
  }));

// The groups a Settings tab renders, each gated by its feature's capability.
export function settingsGroups(tab) {
  return manifests
    .filter((manifest) => manifest.contributes?.settingsGroup?.tab === tab)
    .map(({ id, capability }) => ({ id, capability, SettingsGroup: FEATURES[id].SettingsGroup }));
}
