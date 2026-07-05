const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

const VIDEO_MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
};

// Dedicated localhost HTTP server for <video>. Chromium's media element refuses
// to load from the custom media:// scheme even with stream:true (it uses a
// different loader than fetch), but plays HTTP range streams perfectly. Images
// keep media://; only video uses this. Path is allowlist-checked like media://.
let mediaHttpPort = 0;
const mediaHttpServer = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/media") { res.writeHead(404).end(); return; }
    const filePath = path.resolve(u.searchParams.get("path") || "");
    if (!isAllowedMediaPath(filePath)) {
      await ensureMediaRootsLoaded();
      if (!isAllowedMediaPath(filePath)) { res.writeHead(403).end(); return; }
    }
    if (!fs.existsSync(filePath)) { res.writeHead(404).end(); return; }
    const stat = fs.statSync(filePath);
    const mime = VIDEO_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.writeHead(206, {
        "Content-Type": mime,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    try { res.writeHead(500).end(); } catch { /* ignore */ }
  }
});
mediaHttpServer.listen(0, "127.0.0.1", () => {
  mediaHttpPort = mediaHttpServer.address().port;
  console.log("[media-http] listening on 127.0.0.1:" + mediaHttpPort);
});
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const sharp = require("sharp");

const { makeT } = require("./i18n");
const { findSwiftRuntime } = require("./ipc/swiftRuntime");
const stickerIpc = require("./ipc/stickers");
const depthIpc = require("./ipc/depth");
const collectionsIpc = require("./ipc/collections");
const aiIpc = require("./ipc/ai");
const jobsIpc = require("./ipc/jobs");
const browseIpc = require("./ipc/browse");
const assetsIpc = require("./ipc/assets");
const saveFileIpc = require("./ipc/saveFile");
const annotationIpc = require("./ipc/annotation");
const frameLogosIpc = require("./ipc/frameLogos");
const editorsIpc = require("./ipc/editors");
const watcherModule = require("./watcher");
const { createMcpServer } = require("./mcp/server");
const { createSidecarCommands } = require("./sidecar/commands");
const { createSidecarTransport } = require("./sidecar/transport");

// Test isolation: when AFTERFRAME_USER_DATA is set, redirect userData to that
// directory so E2E tests get a clean catalog/settings/sticker library per run.
// Must happen before any code reads app.getPath("userData").
if (process.env.AFTERFRAME_USER_DATA) {
  app.setPath("userData", process.env.AFTERFRAME_USER_DATA);
}

// Enable the platform HEVC decoder (macOS VideoToolbox) so <video> can play
// HEVC/hvc1 clips (iPhone / 剪映 exports). Must run before app ready, else the
// media element rejects HEVC sources with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4).
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");

protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const configuredCatalogPath = process.env.MEDIA_WORKSPACE_CATALOG;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isPackaged = app.isPackaged;

const rootCandidates = [
  path.resolve(__dirname, "..", "..", ".."),
  path.resolve(process.cwd(), "..", ".."),
  path.resolve(process.cwd(), ".."),
  process.cwd(),
];

function pickRootDir() {
  for (const candidate of rootCandidates) {
    if (fs.existsSync(path.join(candidate, "services", "sidecar", "src"))) {
      return candidate;
    }
  }
  return rootCandidates[0];
}

const rootDir = pickRootDir();

// In packaged mode, sidecar source is in extraResources; in dev, it's in the monorepo
const sidecarSrc = isPackaged
  ? path.join(process.resourcesPath, "sidecar", "src")
  : path.join(rootDir, "services", "sidecar", "src");

// In dev mode, use default catalog paths from the monorepo data/ dir.
// In packaged mode, there is no default — user must create or open a catalog.
const scratchCatalogPath = isPackaged
  ? null
  : path.join(rootDir, "data", "ui-import-scratch.afcatalog");
const reviewCatalogPath = isPackaged
  ? null
  : path.join(rootDir, "data", "review-2026.afcatalog");

function resolveCatalogPath() {
  // Simulate packaged first-run (no default catalog) in dev / e2e, where a
  // scratch catalog would otherwise always be present. Lets you exercise the
  // WelcomeOverlay locally: AFTERFRAME_NO_DEFAULT_CATALOG=1 npm run dev
  if (process.env.AFTERFRAME_NO_DEFAULT_CATALOG) return null;
  if (configuredCatalogPath) {
    return path.isAbsolute(configuredCatalogPath)
      ? configuredCatalogPath
      : path.resolve(rootDir, configuredCatalogPath);
  }
  // Restore last opened catalog (works in both dev and packaged mode)
  const settings = readAppSettings();
  const last = settings.lastCatalogPath;
  if (last && fs.existsSync(last)) return last;
  // Fallback: dev mode uses scratch catalog, packaged mode has no default
  return scratchCatalogPath;
}

let currentCatalogPath = resolveCatalogPath();

function getAppSettingsPath() {
  return path.join(app.getPath("userData"), "afterframe", "settings.json");
}

function readAppSettings() {
  const settingsPath = getAppSettingsPath();
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (error) {
    return {};
  }
}

// Locale: the main process owns it (persisted in settings.json) so the menu and
// the renderer never disagree. The renderer reads it synchronously at startup
// via the preload bridge (app:get-locale).
const SUPPORTED_LOCALES = ["en", "zh-CN"];
function getLocale() {
  const l = readAppSettings().locale;
  return SUPPORTED_LOCALES.includes(l) ? l : "en";
}
let currentLocale = getLocale();

// Serialize all read-modify-write operations to prevent race conditions
let _settingsWriteQueue = Promise.resolve();

async function writeAppSettings(settings) {
  const settingsPath = getAppSettingsPath();
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * Atomically read-modify-write app settings.
 * All callers that modify settings MUST use this to avoid race conditions.
 */
function updateAppSettings(mutateFn) {
  const run = _settingsWriteQueue.then(async () => {
    const settings = readAppSettings();
    const next = mutateFn(settings);
    await writeAppSettings(next);
    return next;
  });
  // Callers get the real result/rejection, but the queue itself reseeds from a
  // settled promise — one failed write must not poison every later write.
  _settingsWriteQueue = run.catch((err) => {
    console.error("[settings] write failed:", err?.message || err);
  });
  return run;
}

function encryptToken(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) return plaintext;
  return safeStorage.encryptString(plaintext).toString("base64");
}

function decryptToken(stored) {
  if (!stored) return null;
  // If it doesn't look like base64-encoded encrypted data, treat as legacy plaintext
  if (!safeStorage.isEncryptionAvailable()) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    // Legacy plaintext token — return as-is
    return stored;
  }
}

function getStoredProviderConfig(provider) {
  const settings = readAppSettings();
  const entry = settings?.aiProviders?.[provider];
  if (!entry) return null;
  return { ...entry, token: decryptToken(entry.token) };
}

async function setStoredProviderConfig(provider, config) {
  const encrypted = {
    ...config,
    token: config.token ? encryptToken(config.token) : null,
  };
  await updateAppSettings((settings) => ({
    ...settings,
    aiProviders: {
      ...(settings.aiProviders || {}),
      [provider]: encrypted,
    },
  }));
  return { ...encrypted, token: config.token };
}

async function deleteStoredProviderConfig(provider) {
  await updateAppSettings((settings) => {
    const nextProviders = { ...(settings.aiProviders || {}) };
    delete nextProviders[provider];
    return { ...settings, aiProviders: nextProviders };
  });
}

async function getStoredProviderConfigWithMigration(provider) {
  const existing = getStoredProviderConfig(provider);
  if (existing?.token) {
    // Re-encrypt legacy plaintext tokens transparently
    const settings = readAppSettings();
    const raw = settings?.aiProviders?.[provider]?.token;
    if (raw && safeStorage.isEncryptionAvailable()) {
      try {
        Buffer.from(raw, "base64");
        safeStorage.decryptString(Buffer.from(raw, "base64"));
      } catch {
        // Was plaintext — re-save encrypted
        await setStoredProviderConfig(provider, { token: existing.token });
      }
    }
    return existing;
  }
  try {
    const payload = await callSidecarJsonAsync(["get-provider-token", "--provider", provider]);
    if (payload?.token) {
      const migrated = await setStoredProviderConfig(provider, payload);
      return migrated;
    }
  } catch (error) {
    console.warn("[ai-provider-token] migration lookup failed:", error);
  }
  return existing || null;
}

function catalogHasDb() {
  if (!currentCatalogPath) return false;
  try {
    const entries = fs.readdirSync(currentCatalogPath);
    const has = entries.some((e) => e.endsWith(".sqlite3") || e === "catalog.db");
    console.log("[catalogHasDb]", currentCatalogPath, "entries:", entries.length, "hasDb:", has);
    return has;
  } catch (err) {
    console.warn("[catalogHasDb] error reading dir:", err.message);
    return false;
  }
}

async function prepareCatalogPath() {
  console.log("[prepareCatalogPath] currentCatalogPath:", currentCatalogPath);
  if (!currentCatalogPath) return;
  fs.mkdirSync(currentCatalogPath, { recursive: true });
  if (!catalogHasDb()) {
    console.log("[prepareCatalogPath] empty catalog, skipping sidecar migration");
    return;
  }
  try { await callSidecarAsync(["split-shared-assets"]); } catch (_) { /* best-effort */ }
  try { await callSidecarAsync(["repair-resource-sets"]); } catch (_) { /* best-effort */ }
}

function workspaceInfo() {
  return {
    rootDir,
    catalogPath: currentCatalogPath,
    scratchCatalogPath,
    reviewCatalogPath,
    sidecarSrc,
  };
}

function restartDesktop(nextCatalogPath) {
  const env = { ...process.env };
  if (nextCatalogPath) {
    env.MEDIA_WORKSPACE_CATALOG = nextCatalogPath;
  } else {
    delete env.MEDIA_WORKSPACE_CATALOG;
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  app.quit();
}

function normalizeCatalogPath(targetPath) {
  if (!targetPath) {
    return null;
  }
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(rootDir, targetPath);
  if (resolved.endsWith(".afcatalog")) return resolved;
  if (resolved.endsWith(".mwcatalog")) return resolved.replace(/\.mwcatalog$/, ".afcatalog");
  return `${resolved}.afcatalog`;
}

function createCatalogAt(targetPath) {
  const normalizedPath = normalizeCatalogPath(targetPath);
  if (!normalizedPath) {
    return null;
  }
  fs.mkdirSync(normalizedPath, { recursive: true });
  return normalizedPath;
}

// Sidecar transport lives in ./sidecar/transport.js — resident process,
// one-shot fallback, secret handoff, detached jobs. Aliased here so the
// hundreds of existing call sites stay unchanged.
const sidecarTransport = createSidecarTransport({
  rootDir,
  sidecarSrc,
  isPackaged,
  resourcesPath: process.resourcesPath,
  getCatalogPath: () => currentCatalogPath,
});
const callSidecarAsync = sidecarTransport.callAsync;
const callSidecarJsonAsync = sidecarTransport.callJsonAsync;
const launchSidecarJob = sidecarTransport.launchJob;
const stopResidentSidecar = sidecarTransport.stopResident;


// Domain-verb command layer — the only place argv is assembled. IPC handlers
// and MCP tools both receive this instead of building commands by hand.
const sidecarCommands = createSidecarCommands(callSidecarJsonAsync);


function runPythonJson(script, args = []) {
  if (isPackaged) {
    // In packaged mode, python3 may not be available. Use sidecar binary if possible,
    // otherwise fall back to python3 and let it fail gracefully.
    console.warn("[runPythonJson] called in packaged mode — python3 may not be available");
  }
  const result = spawnSync("python3", ["-c", script, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      PYTHONPATH: sidecarSrc,
    },
    encoding: "utf-8",
    timeout: 10000,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "python helper failed");
  }

  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function formatExifDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toExifRational(value, denominator = 1000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const sign = numeric < 0 ? -1 : 1;
  const scaled = Math.round(Math.abs(numeric) * denominator);
  const divisor = gcd(scaled, denominator);
  return `${sign * (scaled / divisor)}/${denominator / divisor}`;
}

function hasMetadataNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function toExifGpsCoordinate(value) {
  if (!hasMetadataNumber(value)) return null;
  const numeric = Number(value);
  const absolute = Math.abs(numeric);
  const degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (minutesFloat - minutes) * 60;
  const secondsRational = toExifRational(seconds, 10000);
  if (!secondsRational) return null;
  return `${degrees}/1 ${minutes}/1 ${secondsRational}`;
}

function pruneEmptyExifDirectories(exif) {
  return Object.fromEntries(
    Object.entries(exif).filter(([, entries]) => entries && Object.keys(entries).length > 0),
  );
}

function buildExifPayload(metadata) {
  if (!metadata) return null;
  const dateTime = formatExifDateTime(metadata.capture_time);
  const exposureTime = metadata.shutter_speed ? toExifRational(metadata.shutter_speed, 1000000) : null;
  const aperture = metadata.aperture ? toExifRational(metadata.aperture, 1000) : null;
  const focalLength = metadata.focal_length ? toExifRational(metadata.focal_length, 1000) : null;
  const latitude = toExifGpsCoordinate(metadata.gps_latitude);
  const longitude = toExifGpsCoordinate(metadata.gps_longitude);

  const exif = pruneEmptyExifDirectories({
    IFD0: {
      Orientation: "1",
      ...(metadata.camera_make ? { Make: String(metadata.camera_make) } : {}),
      ...(metadata.camera_model ? { Model: String(metadata.camera_model) } : {}),
      ...(metadata.software ? { Software: String(metadata.software) } : {}),
      ...(dateTime ? { DateTime: dateTime } : {}),
    },
    IFD2: {
      ...(dateTime ? { DateTimeOriginal: dateTime } : {}),
      ...(metadata.lens_model ? { LensModel: String(metadata.lens_model) } : {}),
      ...(metadata.iso != null ? { ISOSpeedRatings: String(metadata.iso) } : {}),
      ...(aperture ? { FNumber: aperture } : {}),
      ...(exposureTime ? { ExposureTime: exposureTime } : {}),
      ...(focalLength ? { FocalLength: focalLength } : {}),
      ...(metadata.flash != null ? { Flash: String(metadata.flash) } : {}),
      ...(metadata.white_balance != null ? { WhiteBalance: String(metadata.white_balance) } : {}),
      ...(metadata.color_space != null ? { ColorSpace: String(metadata.color_space) } : {}),
    },
    IFD3: {
      ...(latitude
        ? {
            GPSLatitudeRef: Number(metadata.gps_latitude) >= 0 ? "N" : "S",
            GPSLatitude: latitude,
          }
        : {}),
      ...(longitude
        ? {
            GPSLongitudeRef: Number(metadata.gps_longitude) >= 0 ? "E" : "W",
            GPSLongitude: longitude,
          }
        : {}),
    },
  });

  return Object.keys(exif).length ? exif : null;
}

function readSourceMetadataForExport(sourcePath) {
  if (!sourcePath) return null;
  const script = `
import json
import sys
from pathlib import Path
from media_workspace.metadata import extract_image_candidate

meta = extract_image_candidate(Path(sys.argv[1]))
print(json.dumps({
    "capture_time": meta.capture_time,
    "camera_make": meta.camera_make,
    "camera_model": meta.camera_model,
    "lens_model": meta.lens_model,
    "software": meta.software,
    "iso": meta.iso,
    "aperture": meta.aperture,
    "shutter_speed": meta.shutter_speed,
    "focal_length": meta.focal_length,
    "flash": meta.flash,
    "white_balance": meta.white_balance,
    "color_space": meta.color_space,
    "gps_latitude": meta.gps_latitude,
    "gps_longitude": meta.gps_longitude,
}))
`;
  return runPythonJson(script, [sourcePath]);
}

async function writeImageWithSourceMetadata(targetPath, outputBuffer, sourceMetadataPath) {
  const ext = path.extname(targetPath).toLowerCase();
  let pipeline = sharp(outputBuffer, { limitInputPixels: false }).withMetadata({ orientation: 1 });

  if (sourceMetadataPath) {
    try {
      const [structuredMetadata, sourceSharpMeta] = await Promise.all([
        Promise.resolve(readSourceMetadataForExport(sourceMetadataPath)),
        sharp(sourceMetadataPath, { limitInputPixels: false }).metadata(),
      ]);
      const exif = buildExifPayload(structuredMetadata);
      if (exif) {
        pipeline = pipeline.withExif(exif);
      }
      if (sourceSharpMeta.xmp) {
        pipeline = pipeline.withXmp(sourceSharpMeta.xmp.toString("utf8"));
      }
    } catch (error) {
      console.warn("[save-image] failed to preserve source metadata:", error);
    }
  }

  if (ext === ".png") {
    pipeline = pipeline.png();
  } else if (ext === ".webp") {
    pipeline = pipeline.webp();
  } else {
    pipeline = pipeline.jpeg();
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline.toFile(targetPath);
  return { path: targetPath };
}

function formatJobStatus(job) {
  if (!job) {
    return {
      running: false,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      phase: null,
      phaseLabel: null,
      phaseIndex: 0,
      phaseCount: 0,
      rawDirs: [],
      imageDirs: [],
      mode: null,
      kind: null,
      phaseResults: [],
      progress: 0,
      result: null,
      error: null,
      status: null,
      jobId: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  const payload = job.payload || {};
  const result = job.result || {};
  const status = String(job.status || "");
  return {
    running: status === "queued" || status === "running",
    startedAt: job.created_at || null,
    finishedAt: status === "succeeded" || status === "failed" ? job.updated_at || null : null,
    exitCode: status === "failed" ? 1 : status === "succeeded" ? 0 : null,
    phase: payload.phase || null,
    phaseLabel: payload.phase_label || null,
    phaseIndex: Number(payload.phase_index || 0),
    phaseCount: Number(payload.phase_count || 0),
    rawDirs: Array.isArray(payload.raw_dirs) ? payload.raw_dirs : [],
    imageDirs: Array.isArray(payload.image_dirs) ? payload.image_dirs : [],
    mode: payload.mode || null,
    kind: payload.kind || null,
    phaseResults: Array.isArray(result.phase_results) ? result.phase_results : [],
    progress: Number(job.progress || 0),
    result,
    error: job.error || null,
    status,
    jobId: job.job_id,
    createdAt: job.created_at || null,
    updatedAt: job.updated_at || null,
  };
}

async function latestJobStatus(jobType) {
  return formatJobStatus(await sidecarCommands.latestJob(jobType));
}

async function createJob(jobType, payload) {
  return await sidecarCommands.createJob(jobType, payload);
}

// ---- media:// allowlist ----------------------------------------------------
// The media: protocol must only serve files the app legitimately knows about:
// the catalog (previews/derived), registered raw/export roots, app data
// (sticker library), the HEIC transcode cache, and directories the app itself
// just wrote into (editor saves). Anything else is a renderer-compromise
// escalation to full disk read.
const allowedMediaDirs = new Set();
const baselineMediaDirs = []; // catalog-independent entries, survive resets
let mediaRootsLoaded = null; // promise — lazily refreshed per catalog

// Symlink-safe canonical form. On macOS /var → /private/var, /tmp → /private/tmp:
// the sidecar emits realpath'd absolute paths while config strings keep the
// symlinked form — naive prefix comparison 403's entire catalogs under /tmp.
function canonicalizeMediaPath(p) {
  const resolved = path.resolve(String(p));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved; // not on disk (yet) — compare as-is
  }
}

function addAllowedMediaDir(dir) {
  if (dir) allowedMediaDirs.add(canonicalizeMediaPath(dir));
}

function addBaselineMediaDir(dir) {
  if (!dir) return;
  baselineMediaDirs.push(path.resolve(String(dir)));
  addAllowedMediaDir(dir);
}

function resetMediaAllowlist() {
  allowedMediaDirs.clear();
  mediaRootsLoaded = null;
  for (const dir of baselineMediaDirs) addAllowedMediaDir(dir);
}

function ensureMediaRootsLoaded() {
  if (!mediaRootsLoaded) {
    mediaRootsLoaded = (async () => {
      if (!currentCatalogPath || !catalogHasDb()) return;
      try {
        const roots = await sidecarCommands.catalogRoots();
        for (const root of roots) {
          if (!root?.path) continue;
          addAllowedMediaDir(root.path);
          // Roots are often registered per-file (the user imports individual
          // images from anywhere), which would only allow that exact file and
          // block sibling derivatives written next to it — AI repaint outputs,
          // editor saves, crops. Allow the containing directory too so anything
          // in a folder the user imported from can be served.
          try {
            if (!fs.statSync(root.path).isDirectory()) {
              addAllowedMediaDir(path.dirname(root.path));
            }
          } catch { /* path vanished from disk — skip */ }
        }
      } catch (err) {
        console.warn("[media] failed to load catalog roots for allowlist:", err.message);
        mediaRootsLoaded = null; // retry on next request
      }
    })();
  }
  return mediaRootsLoaded;
}

function isAllowedMediaPath(requestedPath) {
  const resolved = canonicalizeMediaPath(requestedPath);
  if (currentCatalogPath) {
    const catalogCanonical = canonicalizeMediaPath(currentCatalogPath);
    if (resolved === catalogCanonical || resolved.startsWith(catalogCanonical + path.sep)) return true;
  }
  for (const dir of allowedMediaDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

async function registerRoots(rootType, paths) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))];
  if (!uniquePaths.length) {
    return [];
  }
  for (const targetPath of uniquePaths) addAllowedMediaDir(targetPath);
  return await sidecarCommands.registerRoots(rootType, uniquePaths);
}

async function startEnrichmentTask() {
  const current = await latestJobStatus("enrichment");
  if (current.running) {
    return current;
  }
  const job = await createJob("enrichment", {});
  launchSidecarJob(["run-enrichment-job", "--job-id", job.job_id]);
  return formatJobStatus(job);
}

async function startImportTask(options) {
  const mode = String(options?.mode || "combined");
  const rawDirs = [...new Set((options?.rawDirs || []).filter(Boolean))];
  const imageDirs = [...new Set((options?.imageDirs || []).filter(Boolean))];
  const needsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
  const needsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
  if (needsSources && !rawDirs.length) {
    throw new Error("choose at least one Source file or folder");
  }
  if (needsProcessed && !imageDirs.length) {
    throw new Error("choose at least one image folder");
  }
  const current = await latestJobStatus("import");
  if (current.running) {
    return current;
  }
  const job = await createJob("import", { raw_dirs: rawDirs, image_dirs: imageDirs, mode });
  const command = ["run-import-job", "--job-id", job.job_id, "--mode", mode];
  // HD (2000px) previews are opt-in — Settings ▸ Library. Off by default.
  if (readAppSettings()?.previews?.generateHd === true) {
    command.push("--generate-hd");
  }
  // Auto imports (watched dirs live + catch-up) must not resurrect files the
  // user removed from the catalog but left on disk. Manual imports omit this so
  // an explicit re-import clears the tombstone.
  if (options?.auto === true) {
    command.push("--respect-tombstones");
  }
  for (const rawDir of rawDirs) {
    command.push("--raw-dir", rawDir);
  }
  for (const imageDir of imageDirs) {
    command.push("--image-dir", imageDir);
  }
  launchSidecarJob(command);
  return formatJobStatus(job);
}

async function startPreviewTask(kind = "preview") {
  const current = await latestJobStatus("preview");
  if (current.running) {
    return current;
  }
  const job = await createJob("preview", { kind, asset_type: "image" });
  launchSidecarJob(["run-preview-job", "--job-id", job.job_id, "--kind", kind, "--asset-type", "image"]);
  return formatJobStatus(job);
}

function deriveAiRepaintOutputPath(sourcePath) {
  const source = path.resolve(sourcePath);
  const ext = ".png";
  const parsed = path.parse(source);
  const shortId = crypto.randomBytes(4).toString("hex");
  return path.join(parsed.dir, `${parsed.name}_ai-repaint_${shortId}${ext}`);
}

async function startAiRepaintTask(options) {
  const sourcePath = String(options?.sourcePath || "");
  const prompt = String(options?.prompt || "");
  const providerId = String(options?.provider || "");
  const providerType = String(options?.providerType || "nanobanana");
  if (!sourcePath) {
    throw new Error("Missing source image");
  }
  const model = String(options?.model || "");
  const isUpscale = model === "jimeng_i2i_seed3_tilesr_cvtob";
  if (!prompt.trim() && !isUpscale) {
    throw new Error("Missing prompt");
  }
  const current = await latestJobStatus("ai_repaint");
  if (current.running) {
    return current;
  }
  const providerConfig = await getStoredProviderConfigWithMigration(providerId);
  let apiKey = providerConfig?.token || null;
  let baseUrl = null;
  // For openai_compatible, token is JSON with base_url + token fields
  if (providerType === "openai_compatible" && apiKey) {
    try {
      const parsed = JSON.parse(apiKey);
      apiKey = parsed.token || null;
      baseUrl = parsed.base_url || null;
    } catch (_) { /* plain string token */ }
  }
  if (!apiKey) {
    throw new Error(`No API token configured for provider.`);
  }
  // Output lands next to the original file. For RAW the editor's sourcePath is
  // the (catalog) preview, so callers pass outputBasePath = the original path.
  const outputPath = options?.outputPath || deriveAiRepaintOutputPath(options?.outputBasePath || sourcePath);
  // The sidecar writes the result next to the source; allow the renderer to
  // load it back via media:// (same as editor saves / crops / video proxies).
  // Repaint outputs aren't registered as catalog roots, so without this the
  // before/after compare 403s on the freshly-written file.
  addAllowedMediaDir(path.dirname(outputPath));
  const payload = {
    provider: providerType,
    source_path: sourcePath,
    output_path: outputPath,
    prompt,
    aspect_ratio: options?.aspectRatio || null,
    image_size: options?.resolution ? String(options.resolution).toUpperCase() : null,
    temperature: typeof options?.temperature === "number" ? options.temperature : null,
    model,
  };
  const job = await createJob("ai_repaint", payload);
  const command = [
    "run-ai-repaint-job",
    "--job-id",
    job.job_id,
    "--provider",
    providerType,
    "--input",
    sourcePath,
    "--output",
    outputPath,
    "--origin-path",
    sourcePath,
    "--prompt",
    prompt,
  ];
  if (payload.aspect_ratio) {
    command.push("--aspect-ratio", payload.aspect_ratio);
  }
  if (payload.image_size) {
    command.push("--image-size", payload.image_size);
  }
  if (typeof payload.temperature === "number") {
    command.push("--temperature", String(payload.temperature));
  }
  if (model) {
    command.push("--model", model);
  }
  if (baseUrl) {
    command.push("--base-url", baseUrl);
  }
  command.push("--api-key", apiKey);
  launchSidecarJob(command);
  return formatJobStatus(job);
}

// UI → Agent bridge: the renderer reports every selection change so the MCP
// get_selection tool can answer "these photos" without a round trip.
let currentSelection = { assets: [], updatedAt: null };
let mcpServerApi = null;
ipcMain.on("workspace:selection-changed", (_event, assets) => {
  currentSelection = { assets: Array.isArray(assets) ? assets : [], updatedAt: new Date().toISOString() };
});

// Agent write tools call this after mutating the catalog so the UI refreshes
// immediately instead of waiting for a manual reload. See docs/agent-native-mcp.md.
function broadcastCatalogChanged(scope, detail = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("workspace:catalog-changed", { scope, reason: "agent", ...detail });
  }
}

// Agent → UI bridge: bring the window forward and ask the renderer to select
// and scroll to the given assets. Resolves with the renderer's ack ({found,
// missing}) or a timeout fallback so MCP tool calls never hang on the UI.
function revealAssetsInApp(assetIds) {
  return new Promise((resolve) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      resolve({ shown: false, error: "App window is not available." });
      return;
    }
    const requestId = crypto.randomUUID();
    const channel = `workspace:agent-reveal-result:${requestId}`;
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(channel);
      resolve({ shown: true, acknowledged: false, requested: assetIds });
    }, 8000);
    ipcMain.once(channel, (_event, result) => {
      clearTimeout(timer);
      resolve({ shown: true, acknowledged: true, ...result });
    });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("workspace:agent-reveal-assets", { requestId, assetIds });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#000000",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // Window shows immediately with splash; React replaces it when ready.
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    console.error(`[renderer:did-fail-load] ${code} ${description} ${validatedURL}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer:gone]", details);
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[renderer:preload-error] ${preloadPath}`, error);
  });
  window.webContents.on("did-finish-load", () => {
    // Cold-launch via dock drop arrives before any window exists, so the
    // open-file events sit in `pendingExternalImports` until we're ready.
    if (pendingExternalImports.length) flushExternalImports();
    // vibepin overlay (dev only): ⌥A to drop a pin on any UI element, type a
    // note, Send → posts to the local daemon on :7331 → /vpin picks it up.
    // The daemon must be running (see .vibepin/ + README); harmless if it isn't.
    if (devServerUrl) {
      window.webContents.executeJavaScript(`
        (function () {
          if (document.getElementById("__vibepin_overlay")) return;
          var s = document.createElement("script");
          s.id = "__vibepin_overlay";
          s.src = "http://127.0.0.1:7331/annotate.js";
          document.body.appendChild(s);
        })();
      `).catch(() => {});
    }
  });
  if (devServerUrl) {
    window.loadURL(devServerUrl);
    return;
  }
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function sendMenuAction(action) {
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!window) {
    return;
  }
  window.webContents.send("workspace:menu-action", action);
}

function buildAppMenu() {
  // We give every `role` item an explicit translated `label` so the whole menu
  // follows the app language, not the OS language. (macOS still auto-injects a
  // few items into the Edit menu — Writing Tools, AutoFill, Dictation, Emoji &
  // Symbols — which we don't create and can't relabel; those stay OS-localized,
  // exactly like every other Mac app.) The app-menu title stays the brand name.
  const t = makeT(currentLocale);
  const template = [
    {
      label: "AfterFrame",
      submenu: [
        { label: t("menu.about"), role: "about" },
        { type: "separator" },
        { label: t("menu.settings"), accelerator: "CmdOrCtrl+,", click: () => sendMenuAction("app:open-settings") },
        { type: "separator" },
        { label: t("menu.scratchCatalog"), click: () => sendMenuAction("catalog:scratch") },
        { type: "separator" },
        { label: t("menu.services"), role: "services" },
        { type: "separator" },
        { label: t("menu.hide"), role: "hide" },
        { label: t("menu.hideOthers"), role: "hideOthers" },
        { label: t("menu.showAll"), role: "unhide" },
        { type: "separator" },
        { label: t("menu.quit"), role: "quit" },
      ],
    },
    {
      label: t("menu.file"),
      submenu: [
        { label: t("menu.newCatalog"), accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("catalog:new") },
        { label: t("menu.openCatalog"), accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("catalog:open") },
        { type: "separator" },
        { label: t("menu.import"), click: () => sendMenuAction("import:pick-export") },
        { label: t("menu.addRawSources"), click: () => sendMenuAction("import:pick-source") },
        { type: "separator" },
        { label: t("menu.runImport"), accelerator: "CmdOrCtrl+I", click: () => sendMenuAction("import:start") },
        { label: t("menu.runEnrichment"), click: () => sendMenuAction("import:enrich") },
        { label: t("menu.generatePreviews"), click: () => sendMenuAction("import:previews") },
        { type: "separator" },
        { label: t("menu.verifyFiles"), click: () => sendMenuAction("library:verify") },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        // Text-editing roles target the focused element natively.
        { label: t("menu.undo"), role: "undo" },
        { label: t("menu.redo"), role: "redo" },
        { type: "separator" },
        { label: t("menu.cut"), role: "cut" },
        { label: t("menu.copy"), role: "copy" },
        { label: t("menu.paste"), role: "paste" },
        { label: t("menu.pasteMatchStyle"), role: "pasteAndMatchStyle" },
        { type: "separator" },
        // Asset-level actions — the renderer acts on the current selection.
        { label: t("menu.copyPath"), click: () => sendMenuAction("edit:copy-path") },
        { label: t("menu.copyName"), click: () => sendMenuAction("edit:copy-name") },
        // No accelerator: a global ⌫ would hijack typing. The renderer owns the
        // Delete/Backspace shortcut and skips it inside text fields.
        { label: t("menu.delete"), click: () => sendMenuAction("edit:delete") },
        { type: "separator" },
        // ⌘A is routed to the renderer so it can pick text-select vs gallery
        // select-all based on focus, instead of role:"selectAll" (text only).
        { label: t("menu.selectAll"), accelerator: "CmdOrCtrl+A", click: () => sendMenuAction("edit:select-all") },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        { label: t("menu.refresh"), accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("view:refresh") },
        { label: t("menu.toggleTheme"), click: () => sendMenuAction("view:toggle-theme") },
        { type: "separator" },
        { label: t("menu.devTools"), role: "toggleDevTools", accelerator: "Alt+CommandOrControl+I" },
        { type: "separator" },
        // Left as a role so macOS keeps the dynamic Enter/Exit Full Screen label.
        { role: "togglefullscreen" },
      ],
    },
    {
      label: t("menu.window"),
      submenu: [
        { label: t("menu.minimize"), role: "minimize" },
        { label: t("menu.zoom"), role: "zoom" },
        { type: "separator" },
        { label: t("menu.front"), role: "front" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

ipcMain.handle("workspace:summary", async () => {
  console.log("[ipc:summary] catalogPath:", currentCatalogPath, "hasDb:", catalogHasDb());
  if (!currentCatalogPath || !catalogHasDb()) {
    return { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  }
  try {
    const payload = await callSidecarAsync(["summary", "--json"]);
    return payload ? JSON.parse(payload) : { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  } catch (err) {
    console.warn("[workspace:summary] sidecar error:", err.message);
    return { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  }
});

ipcMain.handle("workspace:roots", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return [];
  try {
    return await callSidecarJsonAsync(["catalog-roots"]) || [];
  } catch (err) {
    console.warn("[workspace:roots] sidecar error:", err.message);
    return [];
  }
});

ipcMain.handle("workspace:pick-directories", async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: kind === "image" ? "Import files or folders" : "Add raw source files or folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("workspace:register-roots", (_event, rootType, paths) => {
  return registerRoots(rootType, paths);
});

ipcMain.handle("workspace:pick-catalog", async () => {
  const defaultDir = isPackaged
    ? app.getPath("documents")
    : path.join(rootDir, "data");
  const result = await dialog.showOpenDialog({
    title: "Choose catalog",
    properties: ["openDirectory"],
    defaultPath: defaultDir,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("workspace:create-catalog", async () => {
  const defaultDir = isPackaged
    ? path.join(app.getPath("documents"), "AfterFrame")
    : path.join(rootDir, "data");
  const result = await dialog.showSaveDialog({
    title: "Create catalog",
    defaultPath: path.join(defaultDir, "untitled.afcatalog"),
    buttonLabel: "Create Catalog",
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  return createCatalogAt(result.filePath);
});

ipcMain.handle("workspace:switch-catalog", async (_event, nextCatalogPath) => {
  console.log("[ipc:switch-catalog] nextCatalogPath:", nextCatalogPath, "scratchCatalogPath:", scratchCatalogPath);
  if (!nextCatalogPath && !scratchCatalogPath) {
    currentCatalogPath = null;
    console.log("[ipc:switch-catalog] cleared currentCatalogPath (packaged mode, no path)");
    stopResidentSidecar();
    return true;
  }
  currentCatalogPath = normalizeCatalogPath(nextCatalogPath || scratchCatalogPath) || scratchCatalogPath;
  console.log("[ipc:switch-catalog] currentCatalogPath set to:", currentCatalogPath);
  stopResidentSidecar(); // next sidecar call restarts it bound to the new catalog
  // Per-catalog caches must not leak across libraries: media allowlist roots,
  // the agent-facing selection mirror, and the MCP preview-path cache.
  resetMediaAllowlist();
  currentSelection = { assets: [], updatedAt: null };
  mcpServerApi?.clearPreviewCache?.();
  await prepareCatalogPath();
  // Persist last catalog path for next launch
  if (currentCatalogPath) {
    updateAppSettings((s) => ({ ...s, lastCatalogPath: currentCatalogPath }));
  }
  return true;
});

editorsIpc.register({ ipcMain });

const watcherApi = watcherModule.register({
  ipcMain,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  readAppSettings,
  updateAppSettings,
});

jobsIpc.register({
  ipcMain,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
  formatJobStatus, latestJobStatus,
  startImportTask, startEnrichmentTask, startPreviewTask,
  commands: sidecarCommands,
});

aiIpc.register({
  app, ipcMain,
  callSidecarJsonAsync,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
  readAppSettings, updateAppSettings,
  getStoredProviderConfigWithMigration, setStoredProviderConfig, deleteStoredProviderConfig,
  startAiRepaintTask, latestJobStatus, formatJobStatus,
});

const annotationApi = annotationIpc.register({
  ipcMain,
  callSidecarJsonAsync,
  commands: sidecarCommands,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
  readAppSettings, updateAppSettings,
  getStoredProviderConfigWithMigration, setStoredProviderConfig, deleteStoredProviderConfig,
  createJob, launchSidecarJob, latestJobStatus, formatJobStatus,
});

browseIpc.register({
  ipcMain,
  commands: sidecarCommands,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
});

assetsIpc.register({
  ipcMain, shell, dialog, BrowserWindow,
  commands: sidecarCommands, callSidecarJsonAsync, addAllowedMediaDir,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
  t: () => makeT(currentLocale),
});

// Locale: synchronous read for renderer startup; setter persists + rebuilds the
// (main-process) menu so it flips language together with the UI.
ipcMain.on("app:get-locale", (event) => {
  event.returnValue = currentLocale;
});
ipcMain.on("app:get-media-port", (event) => {
  event.returnValue = mediaHttpPort;
});
ipcMain.handle("app:set-locale", (_event, lng) => {
  if (!SUPPORTED_LOCALES.includes(lng)) return currentLocale;
  currentLocale = lng;
  void updateAppSettings((s) => ({ ...s, locale: lng }));
  Menu.setApplicationMenu(buildAppMenu());
  return currentLocale;
});

// Open an app cache directory in Finder (for manual cleanup). These live under
// userData, independent of any catalog.
ipcMain.handle("app:open-cache-dir", (_event, kind) => {
  const dirs = {
    depth: path.join(app.getPath("userData"), "depth-cache"),
    stickers: path.join(app.getPath("userData"), "stickers"),
    videoProxies: path.join(app.getPath("userData"), "video-proxies"),
  };
  const dir = dirs[kind];
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
    return true;
  } catch {
    return false;
  }
});

// Preview settings (e.g. HD generation toggle). Stored under settings.previews.
ipcMain.handle("app:get-preview-settings", () => readAppSettings()?.previews ?? {});
ipcMain.handle("app:save-preview-settings", (_event, next) => {
  void updateAppSettings((s) => ({ ...s, previews: { ...(s?.previews || {}), ...(next || {}) } }));
  return readAppSettings()?.previews ?? {};
});

// On-demand H.264 playback proxy for videos Chromium can't decode (e.g. 10-bit
// HEVC). Transcodes via the bundled video-tool, caches under userData (already
// an allowed media dir), and returns a media:// URL to the proxy. Idempotent.
ipcMain.handle("app:video-proxy", async (_event, originalPath) => {
  try {
    const resolved = path.resolve(String(originalPath || ""));
    if (!isAllowedMediaPath(resolved)) {
      await ensureMediaRootsLoaded();
      if (!isAllowedMediaPath(resolved)) return null;
    }
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    const key = crypto.createHash("sha1").update(`${resolved}:${stat.size}:${stat.mtimeMs}`).digest("hex");
    const dir = path.join(app.getPath("userData"), "video-proxies");
    fs.mkdirSync(dir, { recursive: true });
    addAllowedMediaDir(dir);
    const out = path.join(dir, `${key}.mp4`);
    if (!fs.existsSync(out)) {
      const bin = isPackaged
        ? path.join(process.resourcesPath, "native", "bin", "video-tool")
        : path.join(rootDir, "apps", "desktop", "native", "bin", "video-tool");
      const ok = await new Promise((resolve) => {
        const child = spawn(bin, ["transcode", resolved, out]);
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0 && fs.existsSync(out)));
      });
      if (!ok) { try { fs.unlinkSync(out); } catch { /* ignore */ } return null; }
    }
    return out; // absolute path; renderer serves it via the media HTTP server
  } catch (err) {
    console.error("[video-proxy] failed:", err);
    return null;
  }
});

// Keyframe filmstrip for gallery hover-scrub — small JPEGs (codec-agnostic, no
// playback), generated once via video-tool and cached under userData. Returns
// absolute frame paths (served as images via media://).
ipcMain.handle("app:video-keyframes", async (_event, originalPath, count) => {
  try {
    const resolved = path.resolve(String(originalPath || ""));
    if (!isAllowedMediaPath(resolved)) {
      await ensureMediaRootsLoaded();
      if (!isAllowedMediaPath(resolved)) return [];
    }
    if (!fs.existsSync(resolved)) return [];
    const stat = fs.statSync(resolved);
    const n = Math.max(2, Math.min(24, Number(count) || 12));
    const key = crypto.createHash("sha1").update(`${resolved}:${stat.size}:${stat.mtimeMs}:${n}`).digest("hex");
    const dir = path.join(app.getPath("userData"), "video-keyframes", key);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) {
      fs.mkdirSync(dir, { recursive: true });
      const bin = isPackaged
        ? path.join(process.resourcesPath, "native", "bin", "video-tool")
        : path.join(rootDir, "apps", "desktop", "native", "bin", "video-tool");
      const ok = await new Promise((resolve) => {
        const child = spawn(bin, ["frames", resolved, dir, "--count", String(n), "--max-edge", "320"]);
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
      if (!ok) return [];
    }
    return fs.readdirSync(dir)
      .filter((f) => /^frame_\d+\.jpg$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
      .map((f) => path.join(dir, f));
  } catch (err) {
    console.error("[video-keyframes] failed:", err);
    return [];
  }
});

// Copy arbitrary text (asset paths/names) to the system clipboard. Done in the
// main process so it works regardless of renderer focus / gesture state.
ipcMain.handle("app:copy-text", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

saveFileIpc.register({
  ipcMain, dialog,
  rootDir,
  writeImageWithSourceMetadata,
  addAllowedMediaDir,
});

frameLogosIpc.register({ ipcMain });

// vibepin (dev only): pixel-perfect element/region screenshots for annotations.
// The overlay calls window.__vibepinCapture(rect) → this handler → capturePage.
if (devServerUrl) {
  ipcMain.handle("annotate:capture", async (event, rect) => {
    const img = await event.sender.capturePage(rect);
    return img.toDataURL();
  });
}

// quick-register / collage-sources / delete-image-assets are in ipc/assets.js
// (registered above), so the inline handlers for those are removed here.


ipcMain.on("workspace:is-packaged", (event) => { event.returnValue = isPackaged; });

ipcMain.handle("workspace:info", () => workspaceInfo());

// --- Collections ---

collectionsIpc.register({
  ipcMain,
  commands: sidecarCommands,
  getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
});

ipcMain.handle("workspace:list-system-fonts", async () => {
  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const run = promisify(exec);
    if (process.platform === "darwin") {
      // Use JXA (JavaScript for Automation) via osascript — more reliable than swift CLI
      const { stdout } = await run(
        `osascript -l JavaScript -e 'ObjC.import("AppKit"); const mgr = $.NSFontManager.sharedFontManager; const arr = mgr.availableFontFamilies; const r = []; for (let i = 0; i < arr.count; i++) r.push(arr.objectAtIndex(i).js); r.sort().join("\\n")'`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
      );
      return stdout.trim().split("\n").filter(Boolean);
    } else if (process.platform === "win32") {
      const { stdout } = await run(
        'powershell -Command "[System.Reflection.Assembly]::LoadWithPartialName(\'System.Drawing\') | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"',
        { maxBuffer: 10 * 1024 * 1024 }
      );
      return stdout.trim().split("\r\n").filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
});

// ---- IPC modules: depth + stickers --------------------------------------

depthIpc.register({
  app, ipcMain, dialog,
  isPackaged,
  readAppSettings, updateAppSettings,
  findSwiftRuntime,
});
stickerIpc.register({
  app, ipcMain,
  isPackaged,
  findSwiftRuntime,
  addAllowedMediaDir,
});

// ---- External "Open With…" / dock-icon drop import ------------------------
// macOS fires `open-file` once per dropped file. We batch them in a 50ms window
// then push the list to the renderer. If the window isn't ready yet (cold
// launch via dock drop), we queue and flush after `did-finish-load`.
let pendingExternalImports = [];
let externalImportFlushTimer = null;
function queueExternalImport(filePath) {
  if (!filePath) return;
  pendingExternalImports.push(filePath);
  if (externalImportFlushTimer) clearTimeout(externalImportFlushTimer);
  externalImportFlushTimer = setTimeout(flushExternalImports, 50);
}
function flushExternalImports() {
  externalImportFlushTimer = null;
  if (!pendingExternalImports.length) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || !win.webContents || win.webContents.isLoading()) {
    // Try again once the window is ready.
    return;
  }
  const paths = pendingExternalImports.slice();
  pendingExternalImports = [];
  win.webContents.send("workspace:external-import", paths);
}
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueExternalImport(filePath);
});

app.whenReady().then(() => {
  // Chromium cannot decode HEIC/HEIF, so when the original is requested directly
  // (lightbox, editor, depth) we transcode it to a full-res JPEG on the fly with
  // macOS `sips` and cache the result on disk, keyed by path + mtime + size.
  const HEIC_RE = /\.(heic|heif)$/i;
  const heicCacheDir = path.join(os.tmpdir(), "afterframe-heic-cache");

  function transcodeHeicToJpeg(srcPath) {
    try {
      const stat = fs.statSync(srcPath);
      const key = crypto
        .createHash("md5")
        .update(`${srcPath}:${stat.mtimeMs}:${stat.size}`)
        .digest("hex");
      const outPath = path.join(heicCacheDir, `${key}.jpg`);
      if (fs.existsSync(outPath)) return outPath;
      fs.mkdirSync(heicCacheDir, { recursive: true });
      const result = spawnSync("sips", ["-s", "format", "jpeg", srcPath, "--out", outPath], {
        timeout: 30000,
      });
      if (result.status === 0 && fs.existsSync(outPath)) return outPath;
      console.error("[media] sips HEIC transcode failed:", result.stderr?.toString());
    } catch (err) {
      console.error("[media] HEIC transcode error:", err);
    }
    return null;
  }

  // Baseline allowlist entries that don't depend on the catalog. The whole
  // userData dir is app-owned (settings, sticker library, depth-cache …) —
  // allowing only the afterframe/ subdir broke depth-field loading.
  addBaselineMediaDir(heicCacheDir);
  addBaselineMediaDir(app.getPath("userData"));
  if (!isPackaged) addBaselineMediaDir(rootDir); // dev fixtures / demo assets

  protocol.handle("media", async (request) => {
    // Strip any ?query — the renderer appends a cache-bust token (?r=…) to force
    // an <img> reload after a preview file is regenerated in place; it's not part
    // of the file path.
    const raw = request.url.slice("media://".length).split("?")[0];
    const filePath = raw.split("/").map((seg) => decodeURIComponent(seg)).join(path.sep);
    const resolved = path.resolve(filePath);
    if (!isAllowedMediaPath(resolved)) {
      // Registered roots load lazily — retry once with them present before
      // rejecting (covers the first original-file view after startup).
      await ensureMediaRootsLoaded();
      if (!isAllowedMediaPath(resolved)) {
        console.warn("[media] blocked path outside allowlist:", resolved);
        return new Response("forbidden", { status: 403 });
      }
    }
    const existsOnDisk = fs.existsSync(resolved);
    if (existsOnDisk && HEIC_RE.test(resolved)) {
      const jpeg = transcodeHeicToJpeg(resolved);
      if (jpeg) return net.fetch(pathToFileURL(jpeg).toString());
      // Fall through to original on failure (will surface the load error).
    }
    // Video plays over the localhost media HTTP server (see mediaHttpServer);
    // the media:// scheme stays image-only.
    return net.fetch(pathToFileURL(resolved).toString());
  });

  prepareCatalogPath();
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();
  try { watcherApi.start(); } catch (err) { console.warn("[watcher] start failed:", err?.message || err); }

  // Embedded MCP server — external AI agents (Claude Code etc.) drive the app
  // through this while it runs. Failures must never affect the app itself.
  mcpServerApi = createMcpServer({
    getCatalogState: () => ({ currentCatalogPath, catalogHasDb }),
    callSidecarJsonAsync,
    callSidecarAsync,
    startImportTask,
    formatJobStatus,
    registerRoots,
    revealAssetsInApp,
    getCurrentSelection: () => currentSelection,
    commands: sidecarCommands,
    broadcastCatalogChanged,
    startAnnotationTask: annotationApi.startAnnotationTask,
    startAiRepaintTask,
    readAppSettings,
    sharp,
    // Dev and packaged builds get DIFFERENT default ports so running both at
    // once never collides — and agents deterministically reach the instance
    // they were configured for (repo .mcp.json → dev :41707; user-scope
    // registration → release :41706). Env var still overrides both.
    port: Number(process.env.AFTERFRAME_MCP_PORT) || (isPackaged ? 41706 : 41707),
  });
  mcpServerApi.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopResidentSidecar();
});
