// The in-memory catalog the browser bridge answers from, shared by its
// domain modules (catalog, collections, files, ai, annotation). Photo data is
// session-only: object URLs reference selected Files, no database copies.

// ── assets and collections ──
export const assets = []; // insertion order = import order
export const collections = []; // rows carry asset_ids; item_count derives from it
let nextId = 1;

// Folders nest (parent_collection_id). The folder and every folder under it,
// the folder first; a cycle or a missing parent ends the walk.
export function subtreeIds(collectionId) {
  const out = [];
  const walk = (id) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const row of collections) if (row.kind === "manual" && row.parent_collection_id === id) walk(row.collection_id);
  };
  walk(collectionId);
  return out;
}

// The members of a folder — or, with descendants, of its whole subtree, each
// once, in the order they joined (a photo in several folders keeps its
// earliest place).
export function folderAssetIds(collectionId, includeDescendants = false) {
  const ids = includeDescendants ? subtreeIds(collectionId) : [collectionId];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    for (const assetId of collections.find((c) => c.collection_id === id)?.asset_ids || []) {
      if (!seen.has(assetId)) { seen.add(assetId); out.push(assetId); }
    }
  }
  return out;
}
export const newAssetId = () => `web-${nextId++}`;

// ── BYOK provider keys ──
// Persisted in localStorage at the user's request — the key never leaves
// this browser except in requests straight to the provider.
const TOKENS_KEY = "afterframe.aiTokens";
export const sessionTokens = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(TOKENS_KEY)) || {})); }
  catch { return new Map(); }
})();
export function persistTokens() {
  try { localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(sessionTokens))); }
  catch { /* session-only */ }
}

// ── event subscriptions ──
// useEffect returns these directly: they MUST be synchronous and return an
// unsubscribe function. Sets keep them idempotent under StrictMode double-run.
export const listeners = {
  catalogChanged: new Set(),
  menuAction: new Set(),
  agentReveal: new Set(),
  externalImport: new Set(),
  watchedImport: new Set(),
};
export const subscribe = (set) => (cb) => {
  if (typeof cb !== "function") return undefined;
  set.add(cb);
  return () => set.delete(cb);
};
export function emitCatalogChanged(scope) {
  for (const cb of listeners.catalogChanged) cb({ scope });
}

// electron/main.js formatJobStatus(null) shape.
export const jobStatus = (over = {}) => ({
  running: false, active: false, paused: false,
  startedAt: null, finishedAt: null, exitCode: null,
  phase: null, phaseLabel: null, phaseIndex: 0, phaseCount: 0,
  rawDirs: [], imageDirs: [], mode: null, kind: null, phaseResults: [],
  progress: 0, result: null, error: null, status: null, jobId: null,
  createdAt: null, updatedAt: null,
  ...over,
});

// ── asset record helpers ──

export function hydrateAsset(record, blobs) {
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

// The user's description wins; the AI's caption fills in where there is none.
export function showDescription(asset) {
  const ai = (asset.annotation?.caption || "").trim();
  if (asset.userDescription != null) {
    // An empty one is the user's too: nothing shows.
    asset.description = asset.userDescription.trim() || null;
    asset.description_source = "user";
  } else {
    asset.description = ai || null;
    asset.description_source = ai ? "ai" : null;
  }
  asset.ai_caption = ai || null;
}

export const normalizeTag = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

export const fileExt = (name) => {
  const m = /\.([^.]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : null;
};
