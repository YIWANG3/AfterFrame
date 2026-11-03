// The renderer's registry of feature modules: each manifest's id to what its
// renderer/index.js exports (Panel, useTool, Overlay, SettingsGroup,
// SettingsTab, View, icon, …), and the tables the host UI reads from the
// manifests — the tool-rail rows, the Settings groups and tabs, the sidebar
// views, the layer sources. Hooks are not called from here: EditorOverlay and
// App import a feature's hooks themselves (rules of hooks), see
// docs/feature-modules-plan.md §6 and §8.
import manifests from "./manifests.mjs";
import { rendererExportsFor } from "./manifestSchema.mjs";
import * as lut from "./lut/renderer/index.js";
import * as repaint from "./repaint/renderer/index.js";
import * as sticker from "./sticker/renderer/index.js";

export const FEATURES = { lut, repaint, sticker };

// Every manifest has a renderer here, and that renderer exports what the
// manifest's contributions need (manifestSchema.mjs says which).
for (const manifest of manifests) {
  const renderer = FEATURES[manifest.id];
  if (!renderer) throw new Error(`features/index.js: no renderer registered for the "${manifest.id}" manifest`);
  const missing = rendererExportsFor(manifest).filter((name) => renderer[name] === undefined);
  if (missing.length) throw new Error(`features/index.js: ${manifest.id}/renderer/index.js does not export ${missing.join(", ")}`);
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
    // The component drawn over the canvas while the tool is active, if any.
    Overlay: editorTool.overlay ? FEATURES[id].Overlay : null,
  }));

// The library views feature modules add to the sidebar (Sidebar.jsx lists
// them below the browse rows, App.jsx hosts the active one and holds each
// one's state through the feature's useView hook).
export const sidebarViews = manifests
  .filter((manifest) => manifest.contributes?.sidebarView)
  .map(({ id, capability, contributes: { sidebarView } }) => ({
    id: sidebarView.id,
    labelKey: sidebarView.labelKey,
    icon: FEATURES[id].sidebarIcon,
    cap: capability,
    unavailable: sidebarView.unavailable,
    View: FEATURES[id].View,
    Inspector: FEATURES[id].Inspector,
  }));

// Where the Text tool's layer picker gets its images (TextPanel.jsx shows a
// button per source, StickerPickerModal lists the chosen one): each row is the
// feature's { icon, list, thumbUrl } plus the manifest's id and labels.
export const layerSources = manifests
  .filter((manifest) => manifest.contributes?.layerSource)
  .map(({ id, capability, contributes: { layerSource } }) => ({
    id: layerSource.id,
    labelKey: layerSource.labelKey,
    hideLabelKey: layerSource.hideLabelKey,
    cap: capability,
    ...FEATURES[id].layerSource,
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
