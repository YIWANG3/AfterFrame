const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const sharp = require("sharp");

protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: true } },
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
  if (configuredCatalogPath) {
    return path.isAbsolute(configuredCatalogPath)
      ? configuredCatalogPath
      : path.resolve(rootDir, configuredCatalogPath);
  }
  // In packaged mode, try to restore last opened catalog
  if (isPackaged) {
    const settings = readAppSettings();
    const last = settings.lastCatalogPath;
    if (last && fs.existsSync(last)) return last;
    return null;
  }
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
  _settingsWriteQueue = _settingsWriteQueue.then(async () => {
    const settings = readAppSettings();
    const next = mutateFn(settings);
    await writeAppSettings(next);
    return next;
  });
  return _settingsWriteQueue;
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
  return resolved.endsWith(".afcatalog") ? resolved : `${resolved}.afcatalog`;
}

function createCatalogAt(targetPath) {
  const normalizedPath = normalizeCatalogPath(targetPath);
  if (!normalizedPath) {
    return null;
  }
  fs.mkdirSync(normalizedPath, { recursive: true });
  return normalizedPath;
}

function callSidecar(command) {
  const { cmd, args, env } = sidecarCommand(command);
  console.log("[sidecar:sync]", cmd, args.join(" "));
  const t0 = Date.now();
  const result = spawnSync(cmd, args, { cwd: rootDir, env, encoding: "utf-8", timeout: 30000 });
  console.log("[sidecar:sync] done in", Date.now() - t0, "ms, exit:", result.status);

  if (result.error) {
    console.error("[sidecar:sync] spawn error:", result.error.message);
    throw result.error;
  }
  if (result.status !== 0) {
    console.error("[sidecar:sync] stderr:", result.stderr?.slice(0, 500));
    throw new Error(result.stderr || result.stdout || "sidecar command failed");
  }

  return result.stdout.trim();
}

function callSidecarJson(command) {
  const payload = callSidecar(command);
  return payload ? JSON.parse(payload) : null;
}

function callSidecarAsync(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const { cmd, args, env } = sidecarCommand(command);
    console.log("[sidecar:async]", cmd, args.join(" "));
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: rootDir, env });

    const timer = setTimeout(() => {
      console.error("[sidecar:async] TIMEOUT after", timeoutMs, "ms — killing child");
      child.kill("SIGKILL");
      reject(new Error(`sidecar timed out after ${timeoutMs}ms: ${command.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("close", (code) => {
      clearTimeout(timer);
      console.log("[sidecar:async] done in", Date.now() - t0, "ms, exit:", code);
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString();
        console.error("[sidecar:async] stderr:", stderr.slice(0, 500));
        reject(new Error(stderr || "sidecar command failed"));
        return;
      }
      resolve(Buffer.concat(chunks).toString().trim());
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error("[sidecar:async] spawn error:", err.message);
      reject(err);
    });
  });
}

async function callSidecarJsonAsync(command) {
  const payload = await callSidecarAsync(command);
  return payload ? JSON.parse(payload) : null;
}

// Sidecar: packaged = standalone binary, dev = python3 -m media_workspace
const sidecarBin = isPackaged
  ? path.join(process.resourcesPath, "sidecar", "media-workspace", "media-workspace")
  : null;

function sidecarCommand(command) {
  if (!currentCatalogPath) {
    console.error("[sidecarCommand] No catalog is open! command:", command);
    throw new Error("No catalog is open");
  }
  if (sidecarBin) {
    console.log("[sidecarCommand] using binary:", sidecarBin, "exists:", fs.existsSync(sidecarBin));
    return { cmd: sidecarBin, args: ["--catalog", currentCatalogPath, ...command], env: process.env };
  }
  return {
    cmd: "python3",
    args: ["-m", "media_workspace", "--catalog", currentCatalogPath, ...command],
    env: { ...process.env, PYTHONPATH: sidecarSrc },
  };
}

function spawnDetachedSidecar(command) {
  const { cmd, args, env } = sidecarCommand(command);
  return spawn(cmd, args, { cwd: rootDir, env, detached: true, stdio: "ignore" });
}

function launchSidecarJob(command) {
  const child = spawnDetachedSidecar(command);
  child.unref();
}

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
from media_workspace.metadata import extract_export_candidate

meta = extract_export_candidate(Path(sys.argv[1]))
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
      phaseIndex: 0,
      phaseCount: 0,
      rawDirs: [],
      exportDirs: [],
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
    exportDirs: Array.isArray(payload.export_dirs) ? payload.export_dirs : [],
    mode: payload.mode || null,
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
  const job = await callSidecarJsonAsync(["latest-job", "--job-type", jobType]);
  return formatJobStatus(job);
}

async function createJob(jobType, payload) {
  return await callSidecarJsonAsync(["create-job", "--job-type", jobType, "--payload-json", JSON.stringify(payload || {})]);
}

async function registerRoots(rootType, paths) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))];
  if (!uniquePaths.length) {
    return [];
  }
  const command = ["register-roots", "--root-type", rootType];
  for (const targetPath of uniquePaths) {
    command.push("--path", targetPath);
  }
  return await callSidecarJsonAsync(command) || [];
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
  const exportDirs = [...new Set((options?.exportDirs || []).filter(Boolean))];
  const needsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
  const needsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
  if (needsSources && !rawDirs.length) {
    throw new Error("choose at least one Source file or folder");
  }
  if (needsProcessed && !exportDirs.length) {
    throw new Error("choose at least one Processed Media file or folder");
  }
  const current = await latestJobStatus("import");
  if (current.running) {
    return current;
  }
  const job = await createJob("import", { raw_dirs: rawDirs, export_dirs: exportDirs, mode });
  const command = ["run-import-job", "--job-id", job.job_id, "--mode", mode];
  for (const rawDir of rawDirs) {
    command.push("--raw-dir", rawDir);
  }
  for (const exportDir of exportDirs) {
    command.push("--export-dir", exportDir);
  }
  launchSidecarJob(command);
  return formatJobStatus(job);
}

async function startPreviewTask(kind = "preview") {
  const current = await latestJobStatus("preview");
  if (current.running) {
    return current;
  }
  const job = await createJob("preview", { kind, asset_type: "export" });
  launchSidecarJob(["run-preview-job", "--job-id", job.job_id, "--kind", kind, "--asset-type", "export"]);
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
  const outputPath = options?.outputPath || deriveAiRepaintOutputPath(sourcePath);
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#101010",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  window.once("ready-to-show", () => window.show());
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
  const template = [
    {
      label: "AfterFrame",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Use Scratch Catalog", click: () => sendMenuAction("catalog:scratch") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Catalog", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("catalog:new") },
        { label: "Open Catalog...", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("catalog:open") },
        { type: "separator" },
        { label: "Import", click: () => sendMenuAction("import:pick-export") },
        { label: "Add Raw Sources", click: () => sendMenuAction("import:pick-source") },
        { type: "separator" },
        { label: "Run Import Pipeline", accelerator: "CmdOrCtrl+I", click: () => sendMenuAction("import:start") },
        { label: "Run Enrichment", click: () => sendMenuAction("import:enrich") },
        { label: "Generate Previews", click: () => sendMenuAction("import:previews") },
      ],
    },
    {
      role: "editMenu",
    },
    {
      label: "View",
      submenu: [
        { label: "Refresh", accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("view:refresh") },
        { label: "Toggle Theme", click: () => sendMenuAction("view:toggle-theme") },
        { type: "separator" },
        { role: "toggleDevTools", accelerator: "Alt+CommandOrControl+I" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

ipcMain.handle("workspace:summary", async () => {
  console.log("[ipc:summary] catalogPath:", currentCatalogPath, "hasDb:", catalogHasDb());
  if (!currentCatalogPath || !catalogHasDb()) {
    return { total_exports: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  }
  try {
    const payload = await callSidecarAsync(["summary", "--json"]);
    return payload ? JSON.parse(payload) : { total_exports: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  } catch (err) {
    console.warn("[workspace:summary] sidecar error:", err.message);
    return { total_exports: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
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
    title: kind === "export" ? "Import files or folders" : "Add raw source files or folders",
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
    return true;
  }
  currentCatalogPath = normalizeCatalogPath(nextCatalogPath || scratchCatalogPath) || scratchCatalogPath;
  console.log("[ipc:switch-catalog] currentCatalogPath set to:", currentCatalogPath);
  await prepareCatalogPath();
  // Persist last catalog path for next launch
  if (currentCatalogPath) {
    updateAppSettings((s) => ({ ...s, lastCatalogPath: currentCatalogPath }));
  }
  return true;
});

ipcMain.handle("workspace:import-status", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
  try { return await latestJobStatus("import"); } catch { return formatJobStatus(null); }
});

ipcMain.handle("workspace:import-start", (_event, options) => startImportTask(options));

ipcMain.handle("workspace:enrichment-status", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
  try { return await latestJobStatus("enrichment"); } catch { return formatJobStatus(null); }
});

ipcMain.handle("workspace:enrich-start", () => startEnrichmentTask());

ipcMain.handle("workspace:preview-status", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
  try { return await latestJobStatus("preview"); } catch { return formatJobStatus(null); }
});

ipcMain.handle("workspace:preview-start", (_event, kind) => startPreviewTask(kind || "preview"));

ipcMain.handle("workspace:ai-repaint-status", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
  try { return await latestJobStatus("ai_repaint"); } catch { return formatJobStatus(null); }
});

ipcMain.handle("workspace:ai-repaint-start", (_event, options) => startAiRepaintTask(options));

ipcMain.handle("workspace:list-ai-models", async (_event, providerId, providerType) => {
  const instanceId = String(providerId || "");
  const typeKey = String(providerType || "nanobanana");
  const providerConfig = await getStoredProviderConfigWithMigration(instanceId);
  let apiKey = providerConfig?.token || null;
  let baseUrl = null;
  if (typeKey === "openai_compatible" && apiKey) {
    try {
      const parsed = JSON.parse(apiKey);
      apiKey = parsed.token || null;
      baseUrl = parsed.base_url || null;
    } catch (_) { /* plain string token */ }
  }
  if (!apiKey) return [];
  try {
    const cmd = ["list-ai-models", "--provider", typeKey, "--api-key", apiKey];
    if (baseUrl) cmd.push("--base-url", baseUrl);
    return await callSidecarJsonAsync(cmd) || [];
  } catch (err) {
    console.error("[list-ai-models] error:", err.message);
    return [];
  }
});

ipcMain.handle("workspace:get-ai-preferences", () => {
  const settings = readAppSettings();
  return settings?.aiPreferences ?? {};
});

ipcMain.handle("workspace:save-ai-preferences", async (_event, prefs) => {
  await updateAppSettings((settings) => ({ ...settings, aiPreferences: prefs }));
});

ipcMain.handle("workspace:get-ai-styles", () => {
  const settings = readAppSettings();
  return settings?.aiStyles ?? null;
});

ipcMain.handle("workspace:save-ai-styles", async (_event, styles) => {
  await updateAppSettings((settings) => ({ ...settings, aiStyles: styles }));
});

ipcMain.handle("workspace:list-repaint-history", async (_event, assetPath) => {
  if (!assetPath) return [];
  return await callSidecarJsonAsync(["list-repaint-history", "--asset-path", String(assetPath)]) || [];
});

ipcMain.handle("workspace:get-ai-provider-token", async (_event, provider) => {
  return await getStoredProviderConfigWithMigration(String(provider || "")) || {};
});

ipcMain.handle("workspace:set-ai-provider-token", async (_event, provider, token) => {
  const next = await setStoredProviderConfig(String(provider || ""), { token: String(token || "") });
  return next || {};
});

ipcMain.handle("workspace:delete-ai-provider-token", async (_event, provider) => {
  await deleteStoredProviderConfig(String(provider || ""));
  return { provider: String(provider || ""), configured: false };
});

ipcMain.handle("workspace:pending", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return [];
  try {
    return await callSidecarJsonAsync(["list-pending"]) || [];
  } catch (err) {
    console.warn("[workspace:pending] sidecar error:", err.message);
    return [];
  }
});

ipcMain.handle("workspace:browse", async (_event, options) => {
  console.log("[ipc:browse] catalogPath:", currentCatalogPath, "hasDb:", catalogHasDb(), "options:", JSON.stringify(options));
  if (!currentCatalogPath || !catalogHasDb()) return [];
  const command = [
    "browse-exports",
    "--status",
    options.status,
    "--limit",
    String(options.limit),
    "--offset",
    String(options.offset),
  ];
  if (options.search) {
    command.push("--search", options.search);
  }
  return await callSidecarJsonAsync(command) || [];
});

ipcMain.handle("workspace:detail", async (_event, exportPath) => {
  return await callSidecarJsonAsync(["asset-detail", "--export-path", exportPath]);
});

ipcMain.handle("workspace:detail-by-id", async (_event, assetId) => {
  return await callSidecarJsonAsync(["asset-detail", "--asset-id", assetId]);
});

ipcMain.handle("workspace:reveal", (_event, targetPath) => {
  if (!targetPath) {
    return false;
  }
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle("workspace:pick-save-path", async (_event, options) => {
  const result = await dialog.showSaveDialog({
    title: "Save edited image",
    defaultPath: options?.defaultPath || path.join(rootDir, "data", "edited-image.jpg"),
    buttonLabel: "Save Image",
    filters: Array.isArray(options?.filters) ? options.filters : undefined,
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
});

ipcMain.handle("workspace:save-image", async (_event, targetPath, arrayBuffer, sourceMetadataPath) => {
  if (!targetPath) {
    throw new Error("Missing target path");
  }
  const output = Buffer.from(arrayBuffer);
  return await writeImageWithSourceMetadata(targetPath, output, sourceMetadataPath);
});

ipcMain.handle("workspace:process-and-save", async (_event, options) => {
  const {
    sourcePath,
    savePath,
    quarterTurns = 0,
    freeAngle = 0,
    flipX = false,
    flipY = false,
    crop,
    quality = 92,
  } = options || {};

  if (!sourcePath || !savePath) throw new Error("Missing source or save path");

  const t0 = Date.now();
  console.log("[process-and-save] source:", sourcePath);

  // Read metadata (fast — no pixel decode)
  const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
  const needsExifOrient = meta.orientation && meta.orientation !== 1;

  // EXIF orientation decomposition: rotation angle + optional horizontal mirror (flop).
  // Sharp pipeline order is: rotate → flop → flip, but EXIF semantics apply mirror BEFORE rotation.
  // Flop then Rotate(θ) ≡ Rotate(−θ) then Flop, so we negate the EXIF angle when mirror is present.
  const EXIF_MAP = {
    1: { angle: 0, flop: false },
    2: { angle: 0, flop: true },
    3: { angle: 180, flop: false },
    4: { angle: 180, flop: true },
    5: { angle: 90, flop: true },   // want: flop→rotate(270) ≡ rotate(−270=90)→flop
    6: { angle: 90, flop: false },
    7: { angle: 270, flop: true },   // want: flop→rotate(90) ≡ rotate(−90=270)→flop
    8: { angle: 270, flop: false },
  };
  const exif = EXIF_MAP[meta.orientation] || { angle: 0, flop: false };

  // Oriented source dimensions (after EXIF would be applied)
  const orientSwaps = [5, 6, 7, 8].includes(meta.orientation);
  const srcW = orientSwaps ? meta.height : meta.width;
  const srcH = orientSwaps ? meta.width : meta.height;

  const discreteAngle = ((quarterTurns * 90) % 360 + 360) % 360;

  // Decide: single-pipeline (fast) vs two-step with temp file (safe for edge cases)
  // Single pipeline works when we can merge EXIF + user transforms into one .rotate() call.
  // That's possible when there's no conflicting .rotate() — i.e. we combine all angles into one.
  const useFastPath = true; // always use single pipeline with EXIF decomposition

  let tmpPath = null;

  try {
    let pipeline;
    let w, h;

    if (useFastPath) {
      // --- Fast path: single pipeline, no intermediate file ---
      pipeline = sharp(sourcePath, { limitInputPixels: false, sequentialRead: true });

      // Combine EXIF angle + discrete user rotation
      const combinedDiscreteAngle = (exif.angle + discreteAngle) % 360;
      // Combine EXIF flop with user flipX (both are horizontal mirrors → XOR)
      const effectiveFlipX = exif.flop !== flipX;

      // Single .rotate() with explicit angle disables EXIF auto-orient
      const totalAngle = combinedDiscreteAngle + freeAngle;
      if (totalAngle !== 0) {
        if (freeAngle === 0) {
          pipeline = pipeline.rotate(combinedDiscreteAngle);
        } else {
          pipeline = pipeline.rotate(totalAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        }
      } else {
        // totalAngle is 0 but we still need to suppress EXIF auto-orient
        pipeline = pipeline.rotate(0);
      }

      if (effectiveFlipX) pipeline = pipeline.flop();
      if (flipY) pipeline = pipeline.flip();

      // Dimension tracking (post-orient, post-discrete-rotation)
      w = srcW;
      h = srcH;
      if (discreteAngle === 90 || discreteAngle === 270) [w, h] = [h, w];

    } else {
      // --- Fallback: two-step via temp file (kept as safety net) ---
      tmpPath = path.join(os.tmpdir(), `afterframe-orient-${Date.now()}.tiff`);
      const orientResult = await sharp(sourcePath, { limitInputPixels: false })
        .rotate()
        .tiff({ compression: "none" })
        .toFile(tmpPath);

      w = orientResult.width;
      h = orientResult.height;

      pipeline = sharp(tmpPath, { limitInputPixels: false });
      if (flipX) pipeline = pipeline.flop();
      if (flipY) pipeline = pipeline.flip();

      const totalAngle = discreteAngle + freeAngle;
      if (totalAngle !== 0) {
        if (freeAngle === 0) {
          pipeline = pipeline.rotate(discreteAngle);
        } else {
          pipeline = pipeline.rotate(totalAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        }
      }

      if (discreteAngle === 90 || discreteAngle === 270) [w, h] = [h, w];
    }

    // Free-angle dimension expansion
    if (freeAngle !== 0) {
      const rad = (freeAngle * Math.PI) / 180;
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      const newW = w * c + h * s;
      const newH = w * s + h * c;
      w = newW;
      h = newH;
    }

    // Crop (normalized 0-1 → pixel coordinates)
    if (crop) {
      const left = Math.max(0, Math.round(crop.x * w));
      const top = Math.max(0, Math.round(crop.y * h));
      const cw = Math.min(Math.round(w) - left, Math.max(1, Math.round(crop.width * w)));
      const ch = Math.min(Math.round(h) - top, Math.max(1, Math.round(crop.height * h)));
      pipeline = pipeline.extract({ left, top, width: cw, height: ch });
    }

    // Preserve EXIF/IPTC/XMP metadata (orientation tag is already handled by explicit .rotate())
    pipeline = pipeline.keepMetadata();

    // Output format
    const ext = path.extname(savePath).toLowerCase();
    if (ext === ".png") {
      pipeline = pipeline.png();
    } else if (ext === ".webp") {
      pipeline = pipeline.webp({ quality });
    } else {
      pipeline = pipeline.jpeg({ quality });
    }

    await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
    const result = await pipeline.toFile(savePath);

    console.log(`[process-and-save] ${result.width}×${result.height} in ${Date.now() - t0}ms → ${savePath}`);
    return { path: savePath, width: result.width, height: result.height };
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
});

ipcMain.handle("workspace:quick-register", async (_event, exportPath, originPath, collageSourceIds) => {
  if (!exportPath) return null;
  const command = ["quick-register", "--export-path", exportPath];
  if (originPath) command.push("--origin-path", originPath);
  if (Array.isArray(collageSourceIds) && collageSourceIds.length) {
    command.push("--collage-source-ids", ...collageSourceIds);
  }
  return await callSidecarJsonAsync(command);
});

ipcMain.handle("workspace:collage-sources", async (_event, assetId) => {
  if (!assetId) return { sources: [], used_in_collages: [] };
  return await callSidecarJsonAsync(["collage-sources", "--asset-id", assetId]);
});

ipcMain.handle("workspace:delete-export-assets", async (_event, assetIds) => {
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const command = ["delete-export-assets"];
  for (const assetId of ids) {
    command.push("--asset-id", String(assetId));
  }
  return await callSidecarJsonAsync(command) || [];
});

ipcMain.on("workspace:is-packaged", (event) => { event.returnValue = isPackaged; });

ipcMain.handle("workspace:info", () => workspaceInfo());

// --- Collections ---

ipcMain.handle("workspace:list-collections", async () => {
  if (!currentCatalogPath || !catalogHasDb()) return [];
  try {
    return await callSidecarJsonAsync(["list-collections"]) || [];
  } catch (err) {
    console.warn("[workspace:list-collections] sidecar error:", err.message);
    return [];
  }
});

ipcMain.handle("workspace:create-collection", async (_event, name, kind) => {
  return await callSidecarJsonAsync(["create-collection", "--name", name, "--kind", kind || "manual"]);
});

ipcMain.handle("workspace:update-collection", async (_event, collectionId, updates) => {
  const command = ["update-collection", "--collection-id", collectionId];
  if (updates.name != null) {
    command.push("--name", updates.name);
  }
  if (updates.rulesJson != null) {
    command.push("--rules-json", updates.rulesJson);
  }
  if (updates.sortOrder != null) {
    command.push("--sort-order", String(updates.sortOrder));
  }
  return await callSidecarJsonAsync(command);
});

ipcMain.handle("workspace:delete-collection", async (_event, collectionId) => {
  return await callSidecarJsonAsync(["delete-collection", "--collection-id", collectionId]);
});

ipcMain.handle("workspace:collection-add-items", async (_event, collectionId, assetIds) => {
  const command = ["collection-add-items", "--collection-id", collectionId];
  for (const id of assetIds) {
    command.push("--asset-id", id);
  }
  return await callSidecarJsonAsync(command);
});

ipcMain.handle("workspace:collection-remove-items", async (_event, collectionId, assetIds) => {
  const command = ["collection-remove-items", "--collection-id", collectionId];
  for (const id of assetIds) {
    command.push("--asset-id", id);
  }
  return await callSidecarJsonAsync(command);
});

ipcMain.handle("workspace:set-asset-rating", async (_event, assetIds, rating) => {
  const command = ["set-asset-rating", "--rating", String(rating)];
  for (const id of assetIds || []) {
    command.push("--asset-id", id);
  }
  return await callSidecarJsonAsync(command);
});

ipcMain.handle("workspace:browse-collection", async (_event, collectionId, options) => {
  if (!currentCatalogPath || !catalogHasDb()) return [];
  return await callSidecarJsonAsync([
    "browse-collection",
    "--collection-id",
    collectionId,
    "--limit",
    String(options?.limit || 120),
    "--offset",
    String(options?.offset || 0),
  ]) || [];
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

app.whenReady().then(() => {
  protocol.handle("media", (request) => {
    const raw = request.url.slice("media://".length);
    const filePath = raw.split("/").map((seg) => decodeURIComponent(seg)).join(path.sep);
    const resolved = path.resolve(filePath);
    const inCatalog = currentCatalogPath && (resolved === currentCatalogPath || resolved.startsWith(currentCatalogPath + path.sep));
    const existsOnDisk = fs.existsSync(resolved);
    if (!inCatalog && !existsOnDisk) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });

  prepareCatalogPath();
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();

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
