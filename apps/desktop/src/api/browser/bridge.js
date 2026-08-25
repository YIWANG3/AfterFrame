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
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "asset_id" });
        if (!db.objectStoreNames.contains("collections")) db.createObjectStore("collections", { keyPath: "collection_id" });
        if (!db.objectStoreNames.contains("repaints")) db.createObjectStore("repaints", { keyPath: "repaint_id" });
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
        // Migration: early web imports stored EXIF Make as `make`.
        const meta = record.image_metadata;
        if (meta?.make && !meta.camera_make) meta.camera_make = meta.make;
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
      // Sidecar field name — frame brand auto-match reads camera_make.
      camera_make: exif.Make || null,
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

// ── AI helpers ──
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime || "image/png" });
}

const randomHex = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)))
  .map((b) => b.toString(16).padStart(2, "0")).join("");

// Sidecar encode_image_for_llm: RGB, longest edge 512, JPEG q85, base64.
async function encodeImageForLlm(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // flatten alpha like the RGB conversion
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  return await blobToBase64(jpeg);
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
  const hydrated = hydrateAsset(record, blobs);
  assets.push(hydrated);
  await persistAsset(record, blobs);
  return hydrated;
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

const fileExt = (name) => {
  const m = /\.([^.]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : null;
};

// Sidecar _search_clause fields, minus paths: stem, camera/lens, annotation
// caption/detected_text/tags.
function matchesSearch(asset, search) {
  const q = String(search).toLowerCase();
  const meta = asset.image_metadata || {};
  const ann = asset.annotation;
  return [asset.stem, meta.camera_model, meta.lens_model, ann?.caption, ann?.detected_text]
    .some((v) => v && String(v).toLowerCase().includes(q))
    || (ann?.tags || []).some((t) => String(t).toLowerCase().includes(q));
}

// Mirrors the sidecar's facet filter semantics (db/browse.py _facet_clauses),
// AND-combined. Faces/annotations/person groups don't exist on the web
// catalog, so "with" matches nothing and "without" matches everything.
function matchesFacetFilters(asset, filters) {
  const meta = asset.image_metadata || {};
  if (filters.camera && meta.camera_model !== filters.camera) return false;
  if (filters.lens && meta.lens_model !== filters.lens) return false;
  for (const [key, field] of [["iso", "iso"], ["aperture", "aperture"], ["focal", "focal_length"], ["shutter", "shutter_speed"]]) {
    const lo = filters[`${key}_min`];
    const hi = filters[`${key}_max`];
    if (lo != null && !(meta[field] != null && meta[field] >= lo)) return false;
    if (hi != null && !(meta[field] != null && meta[field] <= hi)) return false;
  }
  const day = meta.capture_time ? String(meta.capture_time).slice(0, 10) : null;
  if (filters.date_from && !(day && day >= String(filters.date_from).slice(0, 10))) return false;
  if (filters.date_to && !(day && day <= String(filters.date_to).slice(0, 10))) return false;
  if (filters.rating_min != null && !(asset.app_rating >= filters.rating_min)) return false;
  if (filters.orientation === "portrait" && !(meta.height > meta.width)) return false;
  if (filters.orientation === "landscape" && !(meta.width > meta.height)) return false;
  if (filters.orientation === "square" && !(meta.width && meta.width === meta.height)) return false;
  if (filters.extension && fileExt(asset.file_name) !== String(filters.extension).toLowerCase().replace(/^\./, "")) return false;
  if (filters.tag) {
    const t = normalizeTag(filters.tag);
    if (!(asset.annotation?.tags || []).some((x) => normalizeTag(x) === t)) return false;
  }
  if (filters.people === "with_faces") return false;
  if (filters.annotated === "with" && !asset.annotation) return false;
  if (filters.annotated === "without" && asset.annotation) return false;
  if (filters.person_group) return false;
  if (filters.geo && !matchesGeo(meta, filters.geo)) return false;
  return true;
}

// Map viewport filter (sidecar _geo_filter_clause semantics). Web locations
// only come from EXIF, so exclude-exif or place mode can never match.
function matchesGeo(meta, geo) {
  if (!geo || typeof geo !== "object") return true;
  if (geo.mode === "place") return false;
  if (geo.mode !== "bounds") return true;
  if (geo.include_exif === false) return false;
  const lat = meta.gps_latitude;
  const lon = meta.gps_longitude;
  if (lat == null || lon == null) return false;
  const west = Number(geo.west); const east = Number(geo.east);
  const south = Number(geo.south); const north = Number(geo.north);
  if (![west, east, south, north].every(Number.isFinite)) return true;
  if (!(lat >= south && lat <= north)) return false;
  // Antimeridian-crossing viewport: split the longitude test.
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

// ── AI repaint (Gemini direct fetch, sidecar ai_repaint.py semantics) ──
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-3-pro-image-preview";
const GEMINI_MODELS_WITH_IMAGE_SIZE = new Set(["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"]);

let repaintJob = null; // singleton, mirrors formatJobStatus fields the panel reads

async function geminiGenerateImage({ apiKey, model, prompt, sourceBlob, aspectRatio, imageSize }) {
  const generationConfig = { responseModalities: ["TEXT", "IMAGE"] };
  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize && GEMINI_MODELS_WITH_IMAGE_SIZE.has(model)) imageConfig.imageSize = imageSize;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: sourceBlob.type || "image/jpeg", data: await blobToBase64(sourceBlob) } },
        ],
      }],
      generationConfig,
    }),
  });
  if (!res.ok) throw new Error(`Gemini request failed: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const payload = await res.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) return base64ToBlob(inline.data, inline.mimeType || inline.mime_type || "image/png");
  }
  throw new Error(`Gemini returned no image output: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function runRepaint(opts) {
  const providerConfig = sessionTokens.get(opts.provider);
  if (!providerConfig?.token) throw new Error("No API token configured for provider.");
  const source = assets.find((a) => a.image_path === opts.sourcePath)
    || assets.find((a) => a.asset_id === opts.sourcePath);
  const sourceBlob = await (await fetch(opts.sourcePath)).blob();
  const model = opts.model || DEFAULT_GEMINI_MODEL;
  const outputBlob = await geminiGenerateImage({
    apiKey: providerConfig.token,
    model,
    prompt: opts.prompt || "",
    sourceBlob,
    aspectRatio: opts.aspectRatio || null,
    imageSize: opts.resolution ? String(opts.resolution).toUpperCase() : null,
  });
  // Register the result as a catalog asset (the desktop registers it as an
  // ai_repaint version via the sidecar).
  const stem = source?.stem || "image";
  const name = `${stem}_ai-repaint_${randomHex(8)}.png`;
  const outputAsset = await ingestFile(new File([outputBlob], name, { type: outputBlob.type || "image/png" }));
  if (!outputAsset) throw new Error("Could not decode the generated image.");
  // History row survives reloads via asset ids (blob URLs are session-scoped).
  const now = new Date();
  const createdAt = now.toISOString().slice(0, 19).replace("T", " "); // panel appends "Z" itself
  const row = {
    repaint_id: `rp-${Date.now()}-${randomHex(4)}`,
    source_asset_id: source?.asset_id || null,
    output_asset_id: outputAsset.asset_id,
    prompt: opts.prompt || "",
    provider: opts.providerType || "nanobanana",
    model,
    temperature: opts.temperature ?? null,
    aspect_ratio: opts.aspectRatio || null,
    resolution: opts.resolution || null,
    created_at: createdAt,
  };
  try { await idbRun("repaints", "readwrite", (os) => os.put(row)); } catch { /* history is session-only */ }
  return { outputAsset, row };
}

const repaintStatus = () => (repaintJob ? jobStatus(repaintJob) : jobStatus());

// ── AI annotation (Anthropic / OpenAI-compatible direct fetch) ──
const ANNOTATION_SETTINGS_KEY = "afterframe.annotationSettings";
let annotationJob = null; // batch job singleton

function readAnnotationSettings() {
  try { return JSON.parse(localStorage.getItem(ANNOTATION_SETTINGS_KEY)) || {}; } catch { return {}; }
}

const normalizeTag = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

function aggregateTags(limit = 50, needle = "") {
  const q = needle.toLowerCase();
  const m = new Map();
  for (const a of assets) {
    for (const t of a.annotation?.tags || []) {
      if (!q || t.toLowerCase().includes(q)) m.set(t, (m.get(t) || 0) + 1);
    }
  }
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

async function setAssetAnnotation(assetId, annotation) {
  const a = assets.find((x) => x.asset_id === assetId);
  if (a) a.annotation = annotation;
  try {
    await idbRun("assets", "readwrite", (os) => {
      const req = os.get(assetId);
      req.onsuccess = () => {
        if (req.result) { req.result.annotation = annotation; os.put(req.result); }
      };
    });
  } catch { /* session-only */ }
  return annotation;
}

// Sidecar build_system_prompt, condensed to the same contract.
function buildAnnotationSystemPrompt({ languages = ["en", "zh"], maxTags = 10, maxCaptionChars = 200, customInstructions = null, existingTags = [] }) {
  const names = { en: "English", zh: "Chinese" };
  const wanted = (languages.length ? languages : ["en"]).map((l) => names[l] || l).join(" and ");
  let p = "You are a photo annotation assistant. Analyze the image and respond with ONLY a JSON object of this exact shape:\n"
    + `{"caption": "1-2 sentences, at most ${maxCaptionChars} characters", `
    + `"tags": ["up to ${maxTags} lowercase tags, no # symbols"], `
    + `"location": {"country": "", "admin1": "", "locality": "", "landmark": "", "confidence": 0-100} or null when unsure, `
    + `"detected_text": "verbatim text visible in the image" or null}\n`
    + `Write the caption and tags in ${wanted}.`;
  if (existingTags.length) p += `\nPREFER reusing these existing tags when they apply: ${existingTags.slice(0, 200).join(", ")}`;
  if (customInstructions) p += `\nAdditional instructions: ${customInstructions}`;
  p += "\nRespond with ONLY the JSON object.";
  return p;
}

// Sidecar parse_llm_json: strip fences, else grab the first {...} block.
function parseLlmJson(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  if (fence) t = fence[1];
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error("Model did not return valid JSON.");
}

async function callAnnotationProvider({ provider, model, baseUrl, apiKey, systemPrompt, promptText, imageB64 }) {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey || "",
        "anthropic-version": "2023-06-01",
        // Official opt-in for browser BYOK — the user's own key, stored locally.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
            { type: "text", text: promptText },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const payload = await res.json();
    const block = (payload.content || []).find((b) => b.type === "text");
    if (!block?.text) throw new Error("Anthropic returned no text content.");
    return block.text;
  }
  const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
            { type: "text", text: promptText },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible API HTTP ${res.status} at ${base}: ${(await res.text()).slice(0, 300)}`);
  const payload = await res.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Provider returned no content.");
  return typeof text === "string" ? text : JSON.stringify(text);
}

async function annotateOne(opts) {
  const asset = assets.find((a) => a.asset_id === opts.assetId)
    || assets.find((a) => a.image_path === opts.imagePath);
  if (!asset) throw new Error("Asset not found.");
  const apiKey = opts.apiKey || sessionTokens.get(`annotation:${opts.providerId}`)?.token || null;
  const blob = await (await fetch(asset.image_path)).blob();
  const imageB64 = await encodeImageForLlm(blob);
  const systemPrompt = buildAnnotationSystemPrompt({
    languages: opts.languages,
    maxTags: opts.maxTags,
    maxCaptionChars: opts.maxCaptionChars,
    customInstructions: opts.customInstructions,
    existingTags: aggregateTags(200).map((t) => t.value),
  });
  let promptText = "Annotate this image as instructed.";
  if (opts.hint) promptText += ` User correction: this photo was taken at/in: ${opts.hint}. Trust this over visual inference.`;
  const raw = await callAnnotationProvider({
    provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl,
    apiKey, systemPrompt, promptText, imageB64,
  });
  const parsed = parseLlmJson(raw);
  const now = new Date().toISOString();
  const maxTags = opts.maxTags || 10;
  const maxCaption = opts.maxCaptionChars || 200;
  const annotation = {
    asset_id: asset.asset_id,
    provider: opts.provider,
    model: opts.model || null,
    schema_version: 1,
    caption: typeof parsed.caption === "string" ? parsed.caption.slice(0, maxCaption) : "",
    tags: (Array.isArray(parsed.tags) ? parsed.tags : [])
      .map((t) => (typeof t === "string" ? t : t?.tag))
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => normalizeTag(t))
      .slice(0, maxTags),
    location: parsed.location && typeof parsed.location === "object" && !Array.isArray(parsed.location) ? parsed.location : null,
    detected_text: typeof parsed.detected_text === "string" ? parsed.detected_text : null,
    created_at: now,
    updated_at: now,
  };
  await setAssetAnnotation(asset.asset_id, annotation);
  return annotation;
}

// Payload fields AnnotationsSection sends for a single asset — the batch job
// derives the same from stored settings.
function annotationOptsFromSettings(settings) {
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
  if (!active) throw new Error("No annotation provider configured.");
  return {
    providerId: active.id,
    provider: active.type === "anthropic" ? "anthropic" : "openai_compatible",
    model: active.model,
    baseUrl: active.baseUrl || null,
    languages: settings.languages || ["en", "zh"],
    maxTags: settings.maxTags || 10,
    maxCaptionChars: settings.maxCaptionChars || 200,
    customInstructions: settings.customInstructions || null,
  };
}

function resolveAnnotationTargets({ scope = "all", onlyMissing = true, assetIds = null, collectionId = null } = {}) {
  let list = assets;
  if (Array.isArray(assetIds) && assetIds.length) {
    const wanted = new Set(assetIds);
    list = list.filter((a) => wanted.has(a.asset_id));
  } else if (scope === "collection" && collectionId) {
    const row = collections.find((c) => c.collection_id === collectionId);
    const member = new Set(row?.asset_ids || []);
    list = list.filter((a) => member.has(a.asset_id));
  }
  if (onlyMissing) list = list.filter((a) => !a.annotation);
  return list;
}

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
    annotation: true,    // BYOK direct fetch (Anthropic / OpenAI-compatible)
    fileSystem: false,   // reveal in Finder, copy path, refresh/delete from disk
    aiRepaint: true,     // BYOK Gemini direct fetch
    aiRepaintMultiProvider: false, // ark/jimeng/OpenAI need the sidecar
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
  // Settings → General persists the choice; first visit follows the browser.
  getInitialLocale: () => {
    try {
      const saved = localStorage.getItem("afterframe.locale");
      if (saved) return saved;
    } catch { /* fall through */ }
    return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  },
  setLocale: (locale) => {
    try { localStorage.setItem("afterframe.locale", String(locale)); } catch { /* session-only */ }
  },

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
  // Facets aggregate over the in-memory catalog, mirroring the sidecar's
  // get_facet_values keys (db/browse.py).
  getFacetValues: async () => {
    await ensureRestored();
    const metas = assets.map((a) => a.image_metadata || {});
    const counts = (values) => {
      const m = new Map();
      for (const v of values) { if (v) m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([value, count]) => ({ value, count }));
    };
    const minMax = (key) => {
      const vals = metas.map((m) => m[key]).filter((v) => v != null && Number.isFinite(Number(v)));
      return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : { min: null, max: null };
    };
    const times = metas.map((m) => m.capture_time).filter(Boolean).sort();
    return {
      cameras: counts(metas.map((m) => m.camera_model)),
      lenses: counts(metas.map((m) => m.lens_model)),
      tags: aggregateTags(60),
      extensions: counts(assets.map((a) => fileExt(a.file_name))),
      iso: minMax("iso"),
      aperture: minMax("aperture"),
      focal: minMax("focal_length"),
      shutter: minMax("shutter_speed"),
      capture_time: times.length ? { min: times[0], max: times[times.length - 1] } : { min: null, max: null },
    };
  },
  searchFacet: async ({ field, q = "", limit = 50 } = {}) => {
    await ensureRestored();
    const needle = String(q).toLowerCase();
    const pick = (get) => {
      const m = new Map();
      for (const a of assets) {
        const v = get(a);
        if (v && String(v).toLowerCase().includes(needle)) m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([value, count]) => ({ value, count }));
    };
    if (field === "camera") return pick((a) => a.image_metadata?.camera_model);
    if (field === "lens") return pick((a) => a.image_metadata?.lens_model);
    if (field === "extension") return pick((a) => fileExt(a.file_name));
    if (field === "tag") return aggregateTags(limit, needle);
    return [];
  },
  getPreviewSettings: async () => ({ generateHd: false }),
  savePreviewSettings: async () => {},

  // ── browse ──
  browseImages: async ({ status = "all", limit = 180, offset = 0, search, sort, filters } = {}) => {
    await ensureRestored();
    let list = assets;
    if (status === "rated") list = list.filter((a) => a.app_rating > 0);
    else if (status === "matched") list = [];
    if (search) list = list.filter((a) => matchesSearch(a, search));
    if (filters) list = list.filter((a) => matchesFacetFilters(a, filters));
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
  // Location points for the map drawer, scoped like the gallery. Same row
  // shape as the sidecar's browse-map-points; all web points are EXIF-exact.
  browseMapPoints: async ({ status = "all", collectionId, search, filters } = {}) => {
    await ensureRestored();
    let list = assets;
    if (collectionId) {
      const row = collections.find((c) => c.collection_id === collectionId);
      const member = new Set(row?.asset_ids || []);
      list = list.filter((a) => member.has(a.asset_id));
    } else {
      if (status === "rated") list = list.filter((a) => a.app_rating > 0);
      else if (status === "matched") list = [];
      if (search) list = list.filter((a) => matchesSearch(a, search));
      if (filters) {
        const nonGeo = { ...filters };
        delete nonGeo.geo;
        list = list.filter((a) => matchesFacetFilters(a, nonGeo));
      }
    }
    return list
      .filter((a) => a.image_metadata?.gps_latitude != null && a.image_metadata?.gps_longitude != null)
      .map((a) => ({
        asset_id: a.asset_id,
        latitude: a.image_metadata.gps_latitude,
        longitude: a.image_metadata.gps_longitude,
        source: "exif",
        accuracy_m: null,
        precision_level: "exact",
        place_id: null,
        app_rating: a.app_rating,
        capture_time: a.image_metadata.capture_time || null,
        preview_path: a.preview_path,
      }));
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
  getActiveJobs: async () => {
    const jobs = [];
    if (importJob?.running) {
      jobs.push({
        jobId: importJob.jobId,
        jobType: "import",
        kind: "import",
        running: true,
        status: "running",
        progress: importJob.progress,
        result: { current_phase: { result: { processed: importJob.done, total: importJob.total } } },
      });
    }
    if (annotationJob?.running) {
      jobs.push({
        jobId: annotationJob.jobId,
        jobType: "annotation",
        kind: "annotation",
        running: true,
        status: "running",
        progress: annotationJob.progress,
        result: { current_phase: { result: { processed: annotationJob.done, total: annotationJob.total } } },
      });
    }
    return jobs;
  },

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
  listAiModels: async (providerId) => {
    const key = sessionTokens.get(providerId)?.token;
    if (!key) return [];
    try {
      const res = await fetch(`${GEMINI_BASE}/models`, { headers: { "x-goog-api-key": key } });
      if (!res.ok) return [];
      const payload = await res.json();
      const seen = new Map();
      for (const m of payload.models || []) {
        const id = String(m.name || "").replace(/^models\//, "");
        if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
        if (!id.includes("image")) continue;
        const label = m.displayName || id;
        // Prefer non-preview ids per display name, like list_gemini_models.
        if (!seen.has(label) || (seen.get(label).id.includes("preview") && !id.includes("preview"))) {
          seen.set(label, { id, name: label });
        }
      }
      return [...seen.values()];
    } catch { return []; }
  },

  // ── AI repaint job (singleton, ai_repaint.py semantics) ──
  startAiRepaint: async (opts = {}) => {
    await ensureRestored();
    if (repaintJob?.running) return repaintStatus(); // mirror desktop: one at a time
    repaintJob = { running: true, active: true, status: "running", kind: "ai_repaint", error: null, result: null, startedAt: Date.now() };
    void (async () => {
      try {
        const { outputAsset, row } = await runRepaint(opts);
        repaintJob = {
          running: false, active: false, status: "succeeded", kind: "ai_repaint",
          finishedAt: Date.now(), error: null,
          result: {
            provider: row.provider, model: row.model,
            output_path: outputAsset.image_path,
            mime_type: "image/png", prompt: row.prompt,
            asset_id: outputAsset.asset_id, notes: [], current_phase: null,
          },
        };
      } catch (err) {
        repaintJob = { running: false, active: false, status: "failed", kind: "ai_repaint", finishedAt: Date.now(), error: err?.message || String(err), result: null };
      }
    })();
    return repaintStatus();
  },
  getAiRepaintStatus: async () => repaintStatus(),
  listRepaintHistory: async (sourcePath) => {
    await ensureRestored();
    const source = assets.find((a) => a.image_path === sourcePath);
    if (!source) return [];
    let rows;
    try { rows = await idbGetAll("repaints"); } catch { return []; }
    const byId = new Map(assets.map((a) => [a.asset_id, a]));
    return rows
      .filter((r) => r.source_asset_id === source.asset_id && byId.has(r.output_asset_id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => ({
        asset_id: r.output_asset_id,
        output_path: byId.get(r.output_asset_id).image_path,
        parent_asset_id: r.source_asset_id,
        input_path: source.image_path,
        prompt: r.prompt, provider: r.provider, model: r.model,
        temperature: r.temperature, aspect_ratio: r.aspect_ratio,
        resolution: r.resolution, created_at: r.created_at,
      }));
  },

  // ── AI annotation ──
  getAnnotationSettings: async () => readAnnotationSettings(),
  saveAnnotationSettings: async (next) => {
    const merged = { ...readAnnotationSettings(), ...(next || {}) };
    localStorage.setItem(ANNOTATION_SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  },
  getAnnotationKey: async (id) => sessionTokens.get(`annotation:${id}`) || null,
  setAnnotationKey: async (id, token) => { sessionTokens.set(`annotation:${id}`, { token }); return { token }; },
  deleteAnnotationKey: async (id) => { sessionTokens.delete(`annotation:${id}`); },
  annotateAsset: async (opts = {}) => {
    await ensureRestored();
    return await annotateOne(opts);
  },
  getAnnotation: async (assetId) => {
    await ensureRestored();
    return assets.find((a) => a.asset_id === assetId)?.annotation || null;
  },
  addAssetTag: async (assetId, tag) => {
    await ensureRestored();
    const asset = assets.find((a) => a.asset_id === assetId);
    if (!asset) return null;
    const t = normalizeTag(tag);
    const ann = asset.annotation
      ? { ...asset.annotation }
      : { asset_id: assetId, provider: "user", model: "manual", schema_version: 1, caption: "", tags: [], location: null, detected_text: null, created_at: new Date().toISOString() };
    if (t && !ann.tags.some((x) => normalizeTag(x) === t)) ann.tags = [...ann.tags, t];
    ann.updated_at = new Date().toISOString();
    return await setAssetAnnotation(assetId, ann);
  },
  removeAssetTag: async (assetId, tag) => {
    await ensureRestored();
    const asset = assets.find((a) => a.asset_id === assetId);
    if (!asset?.annotation) return asset?.annotation || null;
    const t = normalizeTag(tag);
    const ann = { ...asset.annotation, tags: asset.annotation.tags.filter((x) => normalizeTag(x) !== t), updated_at: new Date().toISOString() };
    return await setAssetAnnotation(assetId, ann);
  },
  listTags: async (limit = 50) => {
    await ensureRestored();
    return aggregateTags(limit).map((t) => t.value);
  },
  clearAiLocation: async (assetId) => {
    await ensureRestored();
    const asset = assets.find((a) => a.asset_id === assetId);
    if (!asset?.annotation) return asset?.annotation || null;
    return await setAssetAnnotation(assetId, { ...asset.annotation, location: null, updated_at: new Date().toISOString() });
  },
  countAnnotationTargets: async (opts = {}) => {
    await ensureRestored();
    return { count: resolveAnnotationTargets(opts).length };
  },
  startAnnotationJob: async (opts = {}) => {
    await ensureRestored();
    if (annotationJob?.running) return jobStatus(annotationJob);
    const targets = resolveAnnotationTargets(opts);
    const shared = annotationOptsFromSettings(readAnnotationSettings()); // throws when unconfigured
    annotationJob = { jobId: `web-annotate-${Date.now()}`, running: true, active: true, status: "running", kind: "annotation", progress: 0, done: 0, failed: 0, total: targets.length };
    void (async () => {
      for (const asset of targets) {
        try {
          await annotateOne({ ...shared, assetId: asset.asset_id, imagePath: asset.image_path });
        } catch { annotationJob.failed += 1; }
        annotationJob.done += 1;
        annotationJob.progress = annotationJob.total ? annotationJob.done / annotationJob.total : 1;
      }
      annotationJob.running = false;
      annotationJob.active = false;
      annotationJob.status = "succeeded";
      annotationJob.finishedAt = Date.now();
      for (const cb of listeners.catalogChanged) cb({ scope: "assets" });
    })();
    return jobStatus(annotationJob);
  },
  getAnnotationJobStatus: async () => (annotationJob ? jobStatus(annotationJob) : jobStatus()),
};
