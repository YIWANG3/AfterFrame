// Browser implementation of the preload bridge, for the static web build
// (web.html). Method names come from shared/ipcChannels.mjs plus preload.js's
// hand-written extras (src/api/apiSurface.test.js checks) — the real App.jsx
// runs against this bridge and never knows which one is behind api.*.
//
// It plays the part of an in-memory catalog backend: an empty catalog on
// boot, "import" backed by the file picker / drag-drop (object URLs, nothing
// leaves the browser), browse/summary/jobs answered from memory. Only what
// the web feature set needs is implemented; desktop-only methods stay absent
// so api.has() reports capability truthfully (depth, sticker extraction,
// native saves all degrade through their existing guards).
//
// This file only assembles. The methods live by domain, each module
// exporting one `<domain>Methods` object (the parity test reads them all):
//   state.js        the in-memory catalog, tokens, subscriptions, job shape
//   query.js        browse semantics (sort, search, facets, smart rules)
//   catalog.js      info, summary, sample library, browse, facets, photo writes
//   collections.js  folders and smart collections
//   files.js        import (picker / drop → ingest job), export (downloads)
//   settings.js     locale, shortcuts, preview settings, watermark profile
//   editor.js       frame logos and templates, personal logos, stickers
//   ai.js           AI repaint and the AI settings store
//   annotation.js   AI annotation, tags, the batch annotation job
//   llm.js          image / JSON plumbing the two BYOK paths share

import { listeners, subscribe } from "./state";
import { catalogMethods } from "./catalog";
import { collectionMethods } from "./collections";
import { fileMethods, activeImportJob } from "./files";
import { settingsMethods } from "./settings";
import { editorMethods } from "./editor";
import { aiMethods } from "./ai";
import { annotationMethods, activeAnnotationJob } from "./annotation";

export const browserBridge = {
  isPackaged: true,
  // The features of shared/capabilities.mjs this build has (true, for the
  // record) and lacks (false: the UI hides it, or shows it locked with a
  // "Desktop app" badge whose click opens the download page, DesktopOnly.jsx).
  capabilities: {
    web: true,
    annotation: true,    // BYOK direct fetch (Anthropic / OpenAI-compatible)
    aiRepaint: true,     // BYOK Gemini direct fetch
    aiRepaintMultiProvider: false, // ark/jimeng/OpenAI need the sidecar
    colors: false,       // dominant colours come from the sidecar's preview pass
    depth: false,
    fileSystem: false,   // reveal in Finder, copy path, refresh/delete from disk
    integrations: false, // MCP server etc.
    libraryManagement: false,
    lut: false,          // no LUT library in the browser yet (docs/lut-plan.md)
    people: false,       // CoreML face indexing
    rawSources: false,   // RAW pairing needs the sidecar
    sidecarJobs: false,  // import pipeline / enrichment / preview generation
    stickerExtract: false,
    video: false,        // decoding/proxy/keyframes live in the sidecar
  },
  openExternal: (url) => { window.open(url, "_blank", "noopener"); },
  // People recognition is desktop-only (capabilities.people): the settings
  // tab and the People view still ask, and get an empty answer.
  listPeopleGroups: async () => [],
  getPeopleIndexStatus: async () => null,
  getPeopleSettings: async () => ({}),

  // ── jobs: the two the browser runs itself ──
  getActiveJobs: async () => [activeImportJob(), activeAnnotationJob()].filter(Boolean),

  // ── subscriptions (synchronous; return unsubscribe) ──
  onCatalogChanged: subscribe(listeners.catalogChanged),
  onMenuAction: subscribe(listeners.menuAction),
  onAgentRevealAssets: subscribe(listeners.agentReveal),
  onExternalImport: subscribe(listeners.externalImport),
  onWatchedImport: subscribe(listeners.watchedImport),
  reportSelection: () => {},
  sendAgentRevealResult: () => {},

  ...catalogMethods,
  ...collectionMethods,
  ...fileMethods,
  ...settingsMethods,
  ...editorMethods,
  ...aiMethods,
  ...annotationMethods,
};
