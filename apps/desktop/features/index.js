// The renderer's registry of feature modules: each manifest's id to what its
// renderer/index.js exports (Panel, useTool, SettingsGroup, icon, …), and the
// tables the host UI reads from the manifests — the tool-rail rows and the
// Settings groups. Hooks are not called from here: EditorOverlay imports a
// feature's hooks itself (rules of hooks), see docs/feature-modules-plan.md §6.
import manifests from "./manifests.mjs";
import * as lut from "./lut/renderer/index.js";

export const FEATURES = { lut };

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

// The groups a Settings tab renders, each gated by its feature's capability.
export function settingsGroups(tab) {
  return manifests
    .filter((manifest) => manifest.contributes?.settingsGroup?.tab === tab)
    .map(({ id, capability }) => ({ id, capability, SettingsGroup: FEATURES[id].SettingsGroup }));
}
