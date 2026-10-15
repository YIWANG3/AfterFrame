// Files in and out: "import" backed by the file picker / drag-drop (object
// URLs, nothing leaves the browser), ingestion as an async job so the
// ActivityCenter shows live progress exactly like a desktop import
// (getActiveJobs poll → finish → refresh), and saves that degrade to
// browser downloads.

import exifr from "exifr";
import { assets, emitCatalogChanged, hydrateAsset, jobStatus, newAssetId } from "./state";
import { getInitialLocale } from "./settings";

// Files staged for import, keyed by the pseudo-path handed to the app
// (pickDirectories/getPathForFile return keys; startImport consumes them).
const pendingFiles = new Map();
let nextPathId = 1;

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
      lens_make: exif.LensMake || null,
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

export async function ingestFile(file, source = "generated") {
  // Real dimensions matter: Gallery treats missing width/height as a broken
  // asset and queues repair loops (Gallery.jsx queueAssetRepair).
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch { /* undecodable file — keep it out of the catalog */ return; }
  const { width, height } = bmp;
  const thumbBlob = await makePreviewBlob(bmp, 512);
  // Keep only a small thumbnail; editing/export reads the original File.
  bmp.close();
  const exifMeta = await readExifMetadata(file);
  // The filename rides in a URL fragment (see hydrateAsset): blob resolution
  // ignores it, but every basename-of-path UI shows the real name — and
  // Gallery's `?r=` cache-bust lands harmlessly inside it.
  const record = {
    asset_id: newAssetId(),
    source,
    asset_type: "image",
    stem: file.name.replace(/\.[^.]+$/, ""),
    file_name: file.name,
    exists_on_disk: true,
    app_rating: 0,
    annotation: null,
    // The photo's tags, hand-added and AI alike; aiTags: the AI ones the user
    // hasn't made theirs, which the next run replaces (as the sidecar's asset_tags).
    tags: [],
    aiTags: [],
    // The description as shown and whose (the user's wins over the AI's).
    description: null,
    description_source: null,
    userDescription: null,
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
  // The original File remains the source for editor and collage exports.
  const blobs = { original: file, thumb: thumbBlob, hd: null };
  const hydrated = hydrateAsset(record, blobs);
  assets.push(hydrated);
  return hydrated;
}

function stageFiles(files) {
  const images = Array.from(files || []).filter((f) => f.type.startsWith("image/") && !f.name.startsWith("._") && !(f.webkitRelativePath || "").split("/").includes("__MACOSX"));
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

// The running import as a getActiveJobs row, or null.
export function activeImportJob() {
  if (!importJob?.running) return null;
  return {
    jobId: importJob.jobId,
    jobType: "import",
    kind: "import",
    running: true,
    status: "running",
    progress: importJob.progress,
    result: { current_phase: { result: { processed: importJob.done, total: importJob.total } } },
  };
}

const isPngBytes = (buffer) => {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
};

// A collage hands saveImage a lossless PNG and leaves the encoding to the save
// (sharp, on desktop). Here the browser does it, once, at the same 0.92.
async function encodePngAsJpeg(buffer) {
  const bmp = await createImageBitmap(new Blob([buffer], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0);
  bmp.close();
  const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  if (!jpeg) throw new Error("Failed to encode image");
  return jpeg;
}

async function downloadBuffer(savePath, buffer) {
  const name = String(savePath).split("/").pop() || "export.jpg";
  const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
  const data = type === "image/jpeg" && isPngBytes(buffer) ? await encodePngAsJpeg(buffer) : buffer;
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Chrome needs the URL alive until the download actually starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fileMethods = {
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
    if (importJob?.running) throw new Error("Please wait for the current import to finish.");
    const incoming = [...imageDirs, ...rawDirs].flatMap(d => pendingFiles.get(d) || []);
    const existing = assets.filter(a => a.source === "user");
    if (existing.length + incoming.length > 30 ||
        existing.reduce((n, a) => n + (a.image_metadata.file_size || 0), 0) + incoming.reduce((n, f) => n + f.size, 0) > 200 * 1024 * 1024) {
      for (const d of [...imageDirs, ...rawDirs]) pendingFiles.delete(d);
      throw new Error(getInitialLocale().startsWith("zh")
        ? "在线体验最多导入 30 张照片、合计 200 MB，示例图片不计入限制。"
        : "The browser demo supports up to 30 imported photos and 200 MB per session. Sample photos do not count toward this limit.");
    }
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
        await ingestFile(file, "user");
        importJob.done += 1;
        importJob.progress = importJob.total ? importJob.done / importJob.total : 1;
      }
      importJob.running = false;
      importJob.status = "succeeded";
      importJob.finishedAt = Date.now();
      // Belt and suspenders alongside job-finish detection: force a browse
      // reload even if the poll never saw this (very fast) job.
      emitCatalogChanged("assets");
    })();
    return importJobStatus();
  },

  // ── jobs the sidecar would run ──
  getImportStatus: async () => importJobStatus(),
  getPreviewStatus: async () => jobStatus(),
  // No colour extraction in the browser: nothing to analyse, ever.
  getColorsStatus: async () => ({ ...jobStatus(), analyzed: 0, missing: 0 }),
  startColorAnalysis: async () => ({ ...jobStatus(), missing: 0 }),
  getEnrichmentStatus: async () => jobStatus(),

  // ── export: file dialogs degrade to browser downloads ──
  pickSavePath: async ({ defaultPath } = {}) => defaultPath || "export.jpg",
  pickDirectory: async () => "downloads",
  saveImage: async (savePath, buffer) => downloadBuffer(savePath, buffer),
  quickRegister: async () => {},
};
