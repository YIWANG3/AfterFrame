// The features a bridge can turn off: the one list of what api.can() checks.
//
// A bridge declares `capabilities` (src/api/index.js). A feature is available
// unless its flag is declared false, so a bridge only lists what it lacks:
//   - the macOS 14 builds declare nothing;
//   - the macOS 12 builds and Windows: electron/capabilities.js;
//   - the web build ("Try in browser"): src/api/browser/bridge.js.
// `web: true` is not a feature: it says the app runs in the browser, for the
// web build's own copy and hints.
//
// A feature is checked with api.can("name"), or named in a table the UI
// passes to api.can(): `cap: "name"` (Settings tabs, toolbar menu) or
// `capability: "name"` (filter bar). src/api/capabilities.test.js keeps this
// list honest: every name checked is a feature here, every feature here is
// checked somewhere, and both bridges declare only these.

export const FEATURES = {
  annotation: "AI annotation (bring your own key)",
  aiRepaint: "AI Repaint",
  aiRepaintMultiProvider: "AI Repaint providers other than Gemini (their APIs need the sidecar)",
  colors: "dominant colours and the colour filter (made by the sidecar's preview pass)",
  depth: "Scene Depth: text behind the subject (Core ML)",
  fileSystem: "Show in Finder, copy path, refresh and delete from disk",
  integrations: "Settings ▸ Integrations: the MCP server for AI agents",
  libraryManagement: "Settings ▸ Library: the catalog, watched folders, previews, analysis, cache and storage",
  lut: "the editor's LUT tool and the LUT library",
  people: "People: face recognition (Vision and Core ML)",
  rawSources: "adding RAW source folders and pairing RAWs with their exports",
  sidecarJobs: "the toolbar's import, metadata and preview tasks, run by the sidecar",
  stickerExtract: "cutting stickers out of photos (Vision)",
  video: "video import and playback (the sidecar decodes)",
};

export const FEATURE_NAMES = Object.keys(FEATURES);
