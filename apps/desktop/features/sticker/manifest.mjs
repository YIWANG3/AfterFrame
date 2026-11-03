// The sticker feature module: cutting a subject out of a photo (Vision, via
// native/bin/extract-sticker) into a PNG the Text tool places as a layer, and
// the Stickers library view in the sidebar. Pure data, read by both processes
// (features/manifests.mjs).
export default {
  // The shape this manifest follows (features/manifestSchema.mjs).
  manifestVersion: 1,
  id: "sticker",
  // The flag api.can() checks (shared/capabilities.mjs). Declared false off
  // macOS, and on the macOS 12 builds that leave the helper out (mac-builds.cjs).
  capability: "stickerExtract",
  platforms: ["darwin"],
  // The Swift CLI in native/bin that does the segmentation. Its source stays
  // at native/extract-sticker.swift: the build scripts know that path.
  helper: "extract-sticker",
  web: false,
  trust: "bundled",
  contributes: {
    // The rail button, locked (not hidden) where the flag is false, and a
    // canvas overlay while the tool is active: the drag-to-draw rect that
    // limits detection (renderer/index.js `Overlay`).
    editorTool: { key: "sticker", labelKey: "overlay.tools.sticker", unavailable: "locked", overlay: true },
    // A library view of its own, entered from the sidebar below the browse
    // rows (Sidebar.jsx places it; App.jsx hosts it); the agent's show_in_app
    // reaches it by the same id. `labelKey` is under the nav namespace.
    sidebarView: { id: "stickers", labelKey: "sidebar.stickers", unavailable: "locked" },
    // Where the Text tool's "add sticker" picker gets its images
    // (renderer/index.js `layerSource`: { icon, list, thumbUrl }); the labels
    // are under the editor namespace.
    layerSource: { id: "stickers", labelKey: "text.addStickerLayer", hideLabelKey: "text.hideStickerPicker" },
    // The bridge methods this feature adds to shared/ipcChannels.mjs,
    // answered by the electron entry below.
    ipc: [
      ["stickerList", "workspace:sticker-list", 0],
      ["stickerDetect", "workspace:sticker-detect", 1],
      ["stickerSave", "workspace:sticker-save", 1],
      ["stickerDelete", "workspace:sticker-delete", 1],
      ["stickerToggleStar", "workspace:sticker-toggle-star", 1],
      ["stickerCleanupScratch", "workspace:sticker-cleanup-scratch", 1],
    ],
  },
  // Main-process entry, relative to this file: exports register(host).
  electron: "./electron/stickers.js",
};
