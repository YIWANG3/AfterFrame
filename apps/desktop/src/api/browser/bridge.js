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
import exifr from "exifr";
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

// Downscale a decoded bitmap to maxDim, or null when the source is already
// small enough. Mirrors the desktop preview tiers (512px gallery thumbs,
// 2000px HD) so the gallery never decodes originals.
async function makePreviewBlob(bmp, maxDim) {
  const scale = maxDim / Math.max(bmp.width, bmp.height);
  if (scale >= 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
}

// ── persistence (IndexedDB) ──
// One row per asset: the catalog record plus original/thumb/hd blobs. The
// catalog restores lazily — every catalog-facing method awaits ensureRestored
// before answering, so components need no boot coordination.
const DB_NAME = "afterframe-web";
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "asset_id" });
        if (!db.objectStoreNames.contains("collections")) db.createObjectStore("collections", { keyPath: "collection_id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbRun(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// URL fields are session-scoped (object URLs) — persist everything else.
const URL_FIELDS = ["_objectUrls", "image_path", "preview_path", "image_preview_path", "image_preview_hd_path", "preview_hd_path"];

async function persistAsset(asset, blobs) {
  const row = { ...asset, _blobs: blobs };
  for (const f of URL_FIELDS) delete row[f];
  try {
    await idbRun("assets", "readwrite", (os) => os.put(row));
  } catch (err) {
    console.warn("[web] persist failed (session-only asset):", err);
  }
}

function hydrateAsset(record, blobs) {
  const url = URL.createObjectURL(blobs.original);
  const thumbUrl = blobs.thumb ? URL.createObjectURL(blobs.thumb) : null;
  const hdUrl = blobs.hd ? URL.createObjectURL(blobs.hd) : null;
  const withName = (u) => `${u}#/${encodeURIComponent(record.file_name || "image.jpg")}`;
  return {
    ...record,
    _objectUrls: [url, thumbUrl, hdUrl].filter(Boolean),
    image_path: withName(url),
    preview_path: withName(thumbUrl || url),
    image_preview_path: withName(thumbUrl || url),
    image_preview_hd_path: withName(hdUrl || url),
    preview_hd_path: withName(hdUrl || url),
  };
}

let restorePromise = null;
function ensureRestored() {
  if (!restorePromise) {
    restorePromise = (async () => {
      try { void navigator.storage?.persist?.(); } catch { /* best effort */ }
      let rows;
      try { rows = await idbGetAll("assets"); } catch { return; }
      const numId = (row) => Number(String(row.asset_id).replace("web-", "")) || 0;
      rows.sort((a, b) => (a.imported_at || "").localeCompare(b.imported_at || "") || numId(a) - numId(b));
      for (const row of rows) {
        const { _blobs, ...record } = row;
        if (!_blobs?.original) continue;
        assets.push(hydrateAsset(record, _blobs));
        if (numId(row) >= nextId) nextId = numId(row) + 1;
      }
      try {
        const cols = await idbGetAll("collections");
        cols.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        collections.push(...cols);
      } catch { /* collections stay empty */ }
    })().catch(() => {});
  }
  return restorePromise;
}

// ── collections (manual albums, sidecar row shape) ──
const collections = []; // rows carry asset_ids; item_count derives from it
const publicCollection = ({ asset_ids, ...row }) => ({ ...row, item_count: asset_ids?.length ?? 0 });
let nextCollectionId = 1;

async function persistCollection(row) {
  try { await idbRun("collections", "readwrite", (os) => os.put(row)); } catch { /* session-only */ }
}
function emitCollectionsChanged() {
  for (const cb of listeners.catalogChanged) cb({ scope: "collections" });
}

// EXIF → the sidecar's image_metadata field names (what Inspector, frame
// auto-params and the capture-time sort read).
async function readExifMetadata(file) {
  try {
    const exif = await exifr.parse(file);
    if (!exif) return {};
    const captureRaw = exif.DateTimeOriginal || exif.CreateDate || null;
    return {
      camera_model: exif.Model || null,
      make: exif.Make || null,
      lens_model: exif.LensModel || null,
      aperture: exif.FNumber ?? null,
      shutter_speed: exif.ExposureTime ?? null,
      iso: exif.ISO ?? null,
      focal_length: exif.FocalLength ?? null,
      capture_time: captureRaw instanceof Date ? captureRaw.toISOString() : captureRaw,
      software: exif.Software || null,
      gps_latitude: exif.latitude ?? null,
      gps_longitude: exif.longitude ?? null,
    };
  } catch { return {}; }
}

async function ingestFile(file) {
  // Real dimensions matter: Gallery treats missing width/height as a broken
  // asset and queues repair loops (Gallery.jsx queueAssetRepair).
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch { /* undecodable file — keep it out of the catalog */ return; }
  const { width, height } = bmp;
  const thumbBlob = await makePreviewBlob(bmp, 512);
  const hdBlob = await makePreviewBlob(bmp, 2000);
  bmp.close();
  const exifMeta = await readExifMetadata(file);
  // The filename rides in a URL fragment (see hydrateAsset): blob resolution
  // ignores it, but every basename-of-path UI shows the real name — and
  // Gallery's `?r=` cache-bust lands harmlessly inside it.
  const record = {
    asset_id: `web-${nextId++}`,
    asset_type: "image",
    stem: file.name.replace(/\.[^.]+$/, ""),
    file_name: file.name,
    exists_on_disk: true,
    app_rating: 0,
    annotation: null,
    has_face: false,
    imported_at: new Date().toISOString(),
    modified_time: Math.floor((file.lastModified || Date.now()) / 1000),
    image_metadata: {
      width,
      height,
      file_size: file.size,
      modified_time: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      ...exifMeta,
    },
  };
  // 2000px tier, same as the desktop's HD previews — collage exports from
  // this; the editor loads image_path (the original) directly.
  const blobs = { original: file, thumb: thumbBlob, hd: hdBlob };
  assets.push(hydrateAsset(record, blobs));
  await persistAsset(record, blobs);
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

// The one active import job; progress surfaces through getActiveJobs /
// getImportStatus like a desktop sidecar import.
let importJob = null;

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

const importJobStatus = () => (importJob
  ? jobStatus({
    jobId: importJob.jobId,
    running: importJob.running,
    active: importJob.running,
    status: importJob.status,
    progress: importJob.progress,
    startedAt: importJob.startedAt,
    finishedAt: importJob.finishedAt,
    kind: "import",
    result: { current_phase: { result: { processed: importJob.done, total: importJob.total } } },
  })
  : jobStatus());

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
  // Explicit false = the matching UI renders locked ("Desktop app" badge,
  // click opens the download page — see DesktopOnly.jsx). Desktop declares none.
  capabilities: {
    web: true,
    catalog: "memory",
    rawSources: false,   // RAW pairing needs the sidecar
    sidecarJobs: false,  // import pipeline / enrichment / preview generation
    annotation: false,   // AI annotation job queue
    fileSystem: false,   // reveal in Finder, copy path, refresh/delete from disk
    aiRepaint: false,    // until the BYOK Gemini fetch path lands (Phase 3)
    depth: false,
    stickerExtract: false,
    people: false,       // CoreML face indexing
    libraryManagement: false,
    integrations: false, // MCP server etc.
    video: false,        // decoding/proxy/keyframes live in the sidecar
  },
  openExternal: (url) => { window.open(url, "_blank", "noopener"); },
  listPeopleGroups: async () => [],
  getPeopleIndexStatus: async () => null,
  getPeopleSettings: async () => ({}),

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
  getSummary: async () => {
    await ensureRestored();
    return {
      image_assets: assets.length,
      raw_assets: 0,
      rated_count: assets.filter((a) => a.app_rating > 0).length,
      confirmed_matches: 0,
      recently_added_count: assets.length,
      updated_at: null,
    };
  },
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
    await ensureRestored();
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
    else if (sort === "captured-asc" || sort === "captured-desc") {
      // ISO strings compare lexicographically; missing capture_time sinks last.
      const key = (a) => a.image_metadata?.capture_time || "￿";
      sorted.sort((a, b) => key(a).localeCompare(key(b)));
      if (sort === "captured-desc") sorted.reverse();
    }
    else if (!sort || sort.endsWith("-desc")) sorted.reverse(); // imported desc
    return sorted.slice(offset, offset + limit);
  },
  browseCollection: async (collectionId, { limit = 180, offset = 0 } = {}) => {
    await ensureRestored();
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return [];
    const byId = new Map(assets.map((a) => [a.asset_id, a]));
    return (row.asset_ids || []).map((id) => byId.get(id)).filter(Boolean).slice(offset, offset + limit);
  },
  listCollections: async () => {
    await ensureRestored();
    return collections.map(publicCollection);
  },
  createCollection: async (name, kind = "manual") => {
    await ensureRestored();
    const now = new Date().toISOString();
    const row = {
      collection_id: `webcol-${Date.now()}-${nextCollectionId++}`,
      name: String(name || "").trim() || "Untitled",
      kind: kind || "manual",
      parent_collection_id: null,
      rules_json: null,
      sort_order: collections.length,
      created_at: now,
      updated_at: now,
      asset_ids: [],
    };
    collections.push(row);
    await persistCollection(row);
    emitCollectionsChanged();
    return publicCollection(row);
  },
  updateCollection: async (collectionId, updates = {}) => {
    await ensureRestored();
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return null;
    if (typeof updates.name === "string" && updates.name.trim()) row.name = updates.name.trim();
    row.updated_at = new Date().toISOString();
    await persistCollection(row);
    emitCollectionsChanged();
    return publicCollection(row);
  },
  deleteCollection: async (collectionId) => {
    await ensureRestored();
    const idx = collections.findIndex((c) => c.collection_id === collectionId);
    if (idx >= 0) collections.splice(idx, 1);
    try { await idbRun("collections", "readwrite", (os) => os.delete(collectionId)); } catch { /* row lingers */ }
    emitCollectionsChanged();
    return { ok: true };
  },
  collectionAddItems: async (collectionId, assetIds) => {
    await ensureRestored();
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return { added: 0 };
    const have = new Set(row.asset_ids);
    const valid = new Set(assets.map((a) => a.asset_id));
    let added = 0;
    for (const id of assetIds || []) {
      if (valid.has(id) && !have.has(id)) { row.asset_ids.push(id); have.add(id); added += 1; }
    }
    if (added) {
      row.updated_at = new Date().toISOString();
      await persistCollection(row);
      emitCollectionsChanged();
    }
    return { added };
  },
  collectionRemoveItems: async (collectionId, assetIds) => {
    await ensureRestored();
    const row = collections.find((c) => c.collection_id === collectionId);
    if (!row) return { removed: 0 };
    const drop = new Set(assetIds || []);
    const before = row.asset_ids.length;
    row.asset_ids = row.asset_ids.filter((id) => !drop.has(id));
    const removed = before - row.asset_ids.length;
    if (removed) {
      row.updated_at = new Date().toISOString();
      await persistCollection(row);
      emitCollectionsChanged();
    }
    return { removed };
  },
  getAssetDetailById: async (assetId) => {
    await ensureRestored();
    return assets.find((a) => a.asset_id === assetId) || null;
  },
  ensureHdPreviews: async () => {},
  setAssetRating: async (assetId, rating) => {
    await ensureRestored();
    const a = assets.find((x) => x.asset_id === assetId);
    if (a) a.app_rating = rating;
    try {
      await idbRun("assets", "readwrite", (os) => {
        const req = os.get(assetId);
        req.onsuccess = () => {
          if (req.result) { req.result.app_rating = rating; os.put(req.result); }
        };
      });
    } catch { /* rating stays session-only */ }
    return { ok: true };
  },
  deleteImageAssets: async (assetIds) => {
    await ensureRestored();
    const ids = new Set(Array.isArray(assetIds) ? assetIds : [assetIds]);
    for (let i = assets.length - 1; i >= 0; i--) {
      if (ids.has(assets[i].asset_id)) {
        for (const u of assets[i]._objectUrls || []) URL.revokeObjectURL(u);
        assets.splice(i, 1);
      }
    }
    try {
      await idbRun("assets", "readwrite", (os) => { for (const id of ids) os.delete(id); });
    } catch { /* records linger; harmless */ }
    // Keep collections consistent with the deleted assets.
    for (const row of collections) {
      const before = row.asset_ids.length;
      row.asset_ids = row.asset_ids.filter((id) => !ids.has(id));
      if (row.asset_ids.length !== before) await persistCollection(row);
    }
    return { removed: ids.size };
  },
  copyText: (text) => navigator.clipboard?.writeText?.(String(text ?? "")),

  // ── import (mapped onto the desktop flow) ──
  // pickDirectories opens the browser file picker and returns a staged
  // pseudo-path; startImport ingests whatever was staged under those paths.
  // getPathForFile does the same per dropped File, so drag-drop import works.
  // Ingestion runs as an async job so the ActivityCenter shows live progress
  // exactly like a desktop import (getActiveJobs poll → finish → refresh).
  pickDirectories: () => pickFiles(),
  getPathForFile: (file) => {
    const key = file?.type?.startsWith("image/") ? stageFiles([file]) : null;
    return key || undefined;
  },
  startImport: async ({ imageDirs = [], rawDirs = [] } = {}) => {
    await ensureRestored(); // ids must resume after restored assets
    const dirs = [...imageDirs, ...rawDirs];
    const files = dirs.flatMap((d) => {
      const staged = pendingFiles.get(d) || [];
      pendingFiles.delete(d);
      return staged;
    });
    importJob = {
      jobId: `web-import-${Date.now()}`,
      running: true, status: "running", progress: 0,
      done: 0, total: files.length,
      startedAt: Date.now(), finishedAt: null,
    };
    void (async () => {
      for (const file of files) {
        await ingestFile(file);
        importJob.done += 1;
        importJob.progress = importJob.total ? importJob.done / importJob.total : 1;
      }
      importJob.running = false;
      importJob.status = "succeeded";
      importJob.finishedAt = Date.now();
      // Belt and suspenders alongside job-finish detection: force a browse
      // reload even if the poll never saw this (very fast) job.
      for (const cb of listeners.catalogChanged) cb({ scope: "assets" });
    })();
    return importJobStatus();
  },

  // ── jobs ──
  getImportStatus: async () => importJobStatus(),
  getPreviewStatus: async () => jobStatus(),
  getEnrichmentStatus: async () => jobStatus(),
  getActiveJobs: async () => (importJob?.running
    ? [{
      jobId: importJob.jobId,
      jobType: "import",
      kind: "import",
      running: true,
      status: "running",
      progress: importJob.progress,
      result: { current_phase: { result: { processed: importJob.done, total: importJob.total } } },
    }]
    : []),

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
