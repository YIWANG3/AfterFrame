// Browser implementation of the preload bridge, for the static web build
// (web.html). Method names mirror electron/preload.js 1:1 — the real App.jsx
// runs against this bridge and never knows which one is behind api.*.
//
// It plays the part of an in-memory catalog backend: an empty catalog on
// boot, "import" backed by the file picker / drag-drop (object URLs, nothing
// leaves the browser), browse/summary/jobs answered from memory. Only what
// the web feature set needs is implemented; desktop-only methods stay absent
// so api.has() reports capability truthfully (depth, sticker extraction,
// native saves all degrade through their existing guards).

// Frame logos: same static assets the desktop reads from disk
// (electron/ipc/frameLogos.js), bundled at build time the way frame-lab.js
// does. Keys mirror the desktop shape: file paths relative to frame-logos/.
import frameLogoManifest from "/frame-logos/logos.json";
const frameLogoGlob = import.meta.glob("/frame-logos/**/*.svg", { query: "?raw", import: "default", eager: true });
const frameLogoSvgs = Object.fromEntries(
  Object.entries(frameLogoGlob).map(([k, v]) => [k.replace("/frame-logos/", ""), v]),
);

// ── in-memory catalog state ──
const assets = []; // insertion order = import order
let nextId = 1;
let nextPathId = 1;
// Files staged for import, keyed by the pseudo-path handed to the app
// (pickDirectories/getPathForFile return keys; startImport consumes them).
const pendingFiles = new Map();
// BYOK provider keys, memory-only (persisting is an explicit opt-in that
// lands with the web repaint phase).
const sessionTokens = new Map();

// ── event subscriptions ──
// useEffect returns these directly: they MUST be synchronous and return an
// unsubscribe function. Sets keep them idempotent under StrictMode double-run.
const listeners = {
  catalogChanged: new Set(),
  menuAction: new Set(),
  agentReveal: new Set(),
  externalImport: new Set(),
  watchedImport: new Set(),
};
const subscribe = (set) => (cb) => {
  if (typeof cb !== "function") return undefined;
  set.add(cb);
  return () => set.delete(cb);
};

async function ingestFile(file) {
  const url = URL.createObjectURL(file);
  // Real dimensions matter: Gallery treats missing width/height as a broken
  // asset and queues repair loops (Gallery.jsx queueAssetRepair).
  let dims;
  try {
    const bmp = await createImageBitmap(file);
    dims = { width: bmp.width, height: bmp.height };
    bmp.close();
  } catch { /* undecodable file — keep it out of the catalog */ return; }
  const { width, height } = dims;
  // The fragment carries the filename: blob resolution ignores it, but every
  // basename-of-path UI (card captions, Inspector, save names) shows the real
  // name — and Gallery's `?r=` cache-bust lands harmlessly inside it.
  const pathUrl = `${url}#/${encodeURIComponent(file.name)}`;
  assets.push({
    _objectUrl: url,
    asset_id: `web-${nextId++}`,
    asset_type: "image",
    image_path: pathUrl,
    preview_path: pathUrl,
    image_preview_path: pathUrl,
    // Original file IS the HD source — also skips the ensureHdPreviews chain.
    image_preview_hd_path: pathUrl,
    preview_hd_path: pathUrl,
    stem: file.name.replace(/\.[^.]+$/, ""),
    file_name: file.name,
    exists_on_disk: true,
    app_rating: 0,
    annotation: null,
    has_face: false,
    modified_time: Math.floor((file.lastModified || Date.now()) / 1000),
    image_metadata: { width, height, file_size: file.size },
  });
}

function stageFiles(files) {
  const images = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
  if (!images.length) return null;
  const key = `/web-import/${nextPathId++}`;
  pendingFiles.set(key, images);
  return key;
}

function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      const key = stageFiles(input.files);
      resolve(key ? [key] : []);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// electron/main.js formatJobStatus(null) shape.
const jobStatus = (over = {}) => ({
  running: false, active: false, paused: false,
  startedAt: null, finishedAt: null, exitCode: null,
  phase: null, phaseLabel: null, phaseIndex: 0, phaseCount: 0,
  rawDirs: [], imageDirs: [], mode: null, kind: null, phaseResults: [],
  progress: 0, result: null, error: null, status: null, jobId: null,
  createdAt: null, updatedAt: null,
  ...over,
});

function downloadBuffer(savePath, buffer) {
  const name = String(savePath).split("/").pop() || "export.jpg";
  const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
  const url = URL.createObjectURL(new Blob([buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Chrome needs the URL alive until the download actually starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const browserBridge = {
  isPackaged: true,
  capabilities: { web: true, catalog: "memory", depth: false, stickerExtract: false },

  // ── locale (read synchronously at i18n import time) ──
  getInitialLocale: () => (navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en"),
  setLocale: () => {},

  // ── workspace / catalog ──
  getInfo: async () => ({
    rootDir: "/",
    catalogPath: "/web.afcatalog",
    scratchCatalogPath: null,
    reviewCatalogPath: null,
    sidecarSrc: null,
    isSampleCatalog: false,
  }),
  getSummary: async () => ({
    image_assets: assets.length,
    raw_assets: 0,
    rated_count: assets.filter((a) => a.app_rating > 0).length,
    confirmed_matches: 0,
    recently_added_count: assets.length,
    updated_at: null,
  }),
  getCatalogRoots: async () => [],
  registerRoots: async () => {},
  getWatchedDirs: async () => [],
  detectEditors: async () => [],
  getFacetValues: async () => null,
  searchFacet: async () => [],
  getPreviewSettings: async () => ({ generateHd: false }),
  savePreviewSettings: async () => {},

  // ── browse ──
  browseImages: async ({ status = "all", limit = 180, offset = 0, search, sort, filters } = {}) => {
    let list = assets;
    if (status === "rated") list = list.filter((a) => a.app_rating > 0);
    else if (status === "matched") list = [];
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((a) => (a.stem || "").toLowerCase().includes(q));
    }
    if (filters?.rating_min) list = list.filter((a) => a.app_rating >= filters.rating_min);
    let sorted = [...list];
    if (sort === "name-asc") sorted.sort((a, b) => a.stem.localeCompare(b.stem));
    else if (sort === "name-desc") sorted.sort((a, b) => b.stem.localeCompare(a.stem));
    else if (sort === "rating-desc") sorted.sort((a, b) => b.app_rating - a.app_rating);
    else if (!sort || sort.endsWith("-desc")) sorted.reverse(); // imported/captured desc
    return sorted.slice(offset, offset + limit);
  },
  browseCollection: async () => [],
  listCollections: async () => [],
  getAssetDetailById: async (assetId) => assets.find((a) => a.asset_id === assetId) || null,
  ensureHdPreviews: async () => {},
  setAssetRating: async (assetId, rating) => {
    const a = assets.find((x) => x.asset_id === assetId);
    if (a) a.app_rating = rating;
    return { ok: true };
  },
  deleteImageAssets: async (assetIds) => {
    const ids = new Set(Array.isArray(assetIds) ? assetIds : [assetIds]);
    for (let i = assets.length - 1; i >= 0; i--) {
      if (ids.has(assets[i].asset_id)) {
        URL.revokeObjectURL(assets[i]._objectUrl);
        assets.splice(i, 1);
      }
    }
    return { removed: ids.size };
  },
  copyText: (text) => navigator.clipboard?.writeText?.(String(text ?? "")),

  // ── import (mapped onto the desktop flow) ──
  // pickDirectories opens the browser file picker and returns a staged
  // pseudo-path; startImport ingests whatever was staged under those paths.
  // getPathForFile does the same per dropped File, so drag-drop import works.
  pickDirectories: () => pickFiles(),
  getPathForFile: (file) => {
    const key = file?.type?.startsWith("image/") ? stageFiles([file]) : null;
    return key || undefined;
  },
  startImport: async ({ imageDirs = [], rawDirs = [] } = {}) => {
    const dirs = [...imageDirs, ...rawDirs];
    for (const dir of dirs) {
      const files = pendingFiles.get(dir) || [];
      pendingFiles.delete(dir);
      for (const file of files) await ingestFile(file);
    }
    const now = Date.now();
    return jobStatus({ status: "succeeded", startedAt: now, finishedAt: now, progress: 1 });
  },

  // ── jobs ──
  getImportStatus: async () => jobStatus(),
  getPreviewStatus: async () => jobStatus(),
  getEnrichmentStatus: async () => jobStatus(),
  getActiveJobs: async () => [],

  // ── subscriptions (synchronous; return unsubscribe) ──
  onCatalogChanged: subscribe(listeners.catalogChanged),
  onMenuAction: subscribe(listeners.menuAction),
  onAgentRevealAssets: subscribe(listeners.agentReveal),
  onExternalImport: subscribe(listeners.externalImport),
  onWatchedImport: subscribe(listeners.watchedImport),
  reportSelection: () => {},
  sendAgentRevealResult: () => {},

  // ── export: file dialogs degrade to browser downloads ──
  pickSavePath: async ({ defaultPath } = {}) => defaultPath || "export.jpg",
  pickDirectory: async () => "downloads",
  saveImage: async (savePath, buffer) => downloadBuffer(savePath, buffer),
  quickRegister: async () => {},

  // ── editor ──
  getFrameLogos: async () => ({ manifest: frameLogoManifest, svgs: frameLogoSvgs }),
  stickerList: async () => [],
  getTextImageStatus: async () => null,

  // ── AI settings store (consumed by AiRepaintPanel on mount) ──
  // Preferences/styles persist in localStorage; provider keys stay in memory
  // only. startAiRepaint stays absent until the Gemini fetch path lands.
  getAiPreferences: async () => {
    try { return JSON.parse(localStorage.getItem("afterframe.aiPrefs")) || {}; } catch { return {}; }
  },
  saveAiPreferences: async (prefs) => {
    localStorage.setItem("afterframe.aiPrefs", JSON.stringify(prefs || {}));
  },
  getAiStyles: async () => {
    try { return JSON.parse(localStorage.getItem("afterframe.aiStyles")); } catch { return null; }
  },
  saveAiStyles: async (styles) => {
    localStorage.setItem("afterframe.aiStyles", JSON.stringify(styles ?? null));
  },
  getAiProviderToken: async (id) => sessionTokens.get(id) || null,
  setAiProviderToken: async (id, token) => { sessionTokens.set(id, { token }); return { token }; },
  deleteAiProviderToken: async (id) => { sessionTokens.delete(id); },
  listAiModels: async () => [],
  listRepaintHistory: async () => [],
  getAiRepaintStatus: async () => null,
};
