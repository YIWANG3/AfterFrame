// The lut feature module (docs/lut-plan.md): the editor's LUT tool and the
// LUT library in Settings ▸ Library. Pure data, read by both processes
// (features/manifests.mjs): no code imports here, only names and paths.
export default {
  // The shape this manifest follows (features/manifestSchema.mjs).
  manifestVersion: 1,
  id: "lut",
  // The flag api.can() checks (shared/capabilities.mjs). Declared false where
  // the feature cannot run: off the platforms below, or without its helper.
  capability: "lut",
  // macOS only for now: a RAW is graded on Apple's RAW rendering, and Windows
  // has no engine of that quality yet.
  platforms: ["darwin"],
  helper: null,
  web: false,
  trust: "bundled",
  contributes: {
    // A button on the editor's tool rail (src/components/editor/editorTools.js
    // places it). Hidden rather than locked where the flag is false.
    editorTool: { key: "lut", labelKey: "overlay.tools.lut", unavailable: "hidden" },
    // A group on a Settings tab, gated by the capability.
    settingsGroup: { tab: "library" },
    // The bridge methods this feature adds to shared/ipcChannels.mjs:
    // [method, channel, arity], answered by the electron entry below.
    ipc: [
      ["listLuts", "app:luts", 0],
      ["readLut", "app:read-lut", 1],
      ["importLuts", "app:import-luts", 1],
      ["addLutFolder", "app:add-lut-folder", 1],
      ["removeLutFolder", "app:remove-lut-folder", 1],
      ["setLutLogMark", "app:set-lut-log-mark", 2],
      ["setLutFavorite", "app:set-lut-favorite", 2],
      ["noteLutUsed", "app:note-lut-used", 1],
      ["revealLut", "app:reveal-lut", 1],
      ["trashLut", "app:trash-lut", 1],
      ["clearLutLibrary", "app:clear-lut-library", 0],
    ],
  },
  // Main-process entry, relative to this file: exports register(host).
  electron: "./electron/luts.js",
};
