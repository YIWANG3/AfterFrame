const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const sharp = require("sharp");

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
const { createMcpServer } = require("./mcp/server");
const { createSidecarCommands } = require("./sidecar/commands");

// Test isolation: when AFTERFRAME_USER_DATA is set, redirect userData to that
// directory so E2E tests get a clean catalog/settings/sticker library per run.
// Must happen before any code reads app.getPath("userData").
if (process.env.AFTERFRAME_USER_DATA) {
  app.setPath("userData", process.env.AFTERFRAME_USER_DATA);
}

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

// Secrets must never ride on argv — `ps` shows it to every local process and
// our transport logs would print it. The transport strips `--api-key <value>`
// here and hands it to the child via env instead; the sidecar falls back to
// MEDIA_WORKSPACE_API_KEY when the flag is absent. (The resident path carries
// commands over stdin JSON, which is already invisible to `ps`.)
function extractSecretEnv(command) {
  const sanitized = [];
  const secretEnv = {};
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === "--api-key" && i + 1 < command.length) {
      secretEnv.MEDIA_WORKSPACE_API_KEY = String(command[i + 1]);
      i += 1;
      continue;
    }
    sanitized.push(command[i]);
  }
  return { sanitized, secretEnv };
}

function redactCommand(command) {
  return command
    .map((arg, i) => (command[i - 1] === "--api-key" ? "***" : String(arg)))
    .join(" ");
}

// ---- Resident sidecar ------------------------------------------------------
// One long-lived `serve` process per catalog answers commands over line-
// delimited JSON, skipping the ~150ms Python spawn+import cost per call.
// Job runners still spawn detached (launchSidecarJob); any resident failure
// falls back to the one-shot path below.
const readline = require("node:readline");
let residentSidecar = null; // { child, pending: Map<id,{resolve,reject,timer}>, nextId, catalogPath }

function stopResidentSidecar() {
  if (!residentSidecar) return;
  const state = residentSidecar;
  residentSidecar = null;
  for (const entry of state.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("resident sidecar stopped"));
  }
  state.pending.clear();
  try { state.child.kill(); } catch (_) { /* already gone */ }
}

function ensureResidentSidecar() {
  if (process.env.AFTERFRAME_SIDECAR_RESIDENT === "0") return null;
  if (!currentCatalogPath) return null;
  if (residentSidecar && residentSidecar.catalogPath === currentCatalogPath) return residentSidecar;
  stopResidentSidecar();
  let spawned;
  try {
    const { cmd, args, env } = sidecarCommand(["serve"]);
    spawned = spawn(cmd, args, { cwd: rootDir, env });
  } catch (err) {
    console.warn("[sidecar:resident] failed to start:", err.message);
    return null;
  }
  const state = { child: spawned, pending: new Map(), nextId: 1, catalogPath: currentCatalogPath };
  const rl = readline.createInterface({ input: spawned.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) {
      console.log("[sidecar:resident] ready for", state.catalogPath);
      return;
    }
    const entry = state.pending.get(msg.id);
    if (!entry) return;
    state.pending.delete(msg.id);
    clearTimeout(entry.timer);
    state.consecutiveTimeouts = 0; // any completed response proves the server is alive
    if (msg.code !== 0) {
      entry.reject(new Error(msg.error || msg.stdout || "sidecar command failed"));
    } else {
      entry.resolve((msg.stdout || "").trim());
    }
  });
  spawned.stderr.on("data", (d) => console.warn("[sidecar:resident:stderr]", String(d).slice(0, 300)));
  // Async spawn failures (ENOENT etc.) arrive as 'error' events, not throws —
  // without a handler they'd crash the whole main process.
  spawned.on("error", (err) => {
    console.warn("[sidecar:resident] process error:", err.message);
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`resident sidecar error: ${err.message}`));
    }
    state.pending.clear();
    if (residentSidecar === state) residentSidecar = null;
  });
  // Late EPIPE on stdin (child died mid-write) is likewise an async event.
  spawned.stdin.on("error", (err) => {
    console.warn("[sidecar:resident] stdin error:", err.message);
  });
  spawned.on("exit", (code) => {
    console.warn("[sidecar:resident] exited with code", code);
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("resident sidecar exited"));
    }
    state.pending.clear();
    if (residentSidecar === state) residentSidecar = null;
  });
  residentSidecar = state;
  return state;
}

function callSidecarResident(command, timeoutMs) {
  const state = ensureResidentSidecar();
  if (!state) return null;
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      console.error("[sidecar:resident] timeout after", timeoutMs, "ms");
      // One slow command shouldn't nuke every other in-flight request — only
      // restart the resident process after consecutive timeouts (it's likely
      // wedged at that point, not just busy).
      state.consecutiveTimeouts = (state.consecutiveTimeouts || 0) + 1;
      if (state.consecutiveTimeouts >= 2) {
        console.error("[sidecar:resident] consecutive timeouts — restarting resident server");
        stopResidentSidecar();
      }
      reject(new Error(`sidecar timed out after ${timeoutMs}ms: ${redactCommand(command)}`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.child.stdin.write(JSON.stringify({ id, argv: command.map(String) }) + "\n");
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      stopResidentSidecar();
      reject(err);
    }
  });
}

async function callSidecarAsync(command, timeoutMs = 30000) {
  // Bind the call to the catalog it was issued against: a catalog switch
  // mid-flight rejects resident requests, and retrying via one-shot would
  // silently rebuild --catalog against the NEW path — wrong-library writes.
  const issuedCatalogPath = currentCatalogPath;
  const residentPromise = callSidecarResident(command, timeoutMs);
  if (residentPromise) {
    try {
      return await residentPromise;
    } catch (err) {
      // Genuine timeouts propagate (the command itself hung); transport-level
      // failures (process died, stopped) retry once via one-shot spawn.
      if (/timed out after/.test(err.message)) throw err;
      if (currentCatalogPath !== issuedCatalogPath) {
        throw new Error(`catalog switched while command was in flight: ${command[0]}`);
      }
      console.warn("[sidecar:resident] falling back to one-shot:", err.message);
    }
  }
  if (currentCatalogPath !== issuedCatalogPath) {
    throw new Error(`catalog switched while command was in flight: ${command[0]}`);
  }
  return callSidecarOneShot(command, timeoutMs);
}

function callSidecarOneShot(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const { sanitized, secretEnv } = extractSecretEnv(command);
    const { cmd, args, env } = sidecarCommand(sanitized);
    console.log("[sidecar:async]", cmd, args.join(" "));
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: rootDir, env: { ...env, ...secretEnv } });

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

// Domain-verb command layer — the only place argv is assembled. IPC handlers
// and MCP tools both receive this instead of building commands by hand.
const sidecarCommands = createSidecarCommands(callSidecarJsonAsync);

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
  const { sanitized, secretEnv } = extractSecretEnv(command);
  const { cmd, args, env } = sidecarCommand(sanitized);
  return spawn(cmd, args, { cwd: rootDir, env: { ...env, ...secretEnv }, detached: true, stdio: "ignore" });
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
      phaseLabel: null,
      phaseIndex: 0,
      phaseCount: 0,
      rawDirs: [],
      exportDirs: [],
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
    exportDirs: Array.isArray(payload.export_dirs) ? payload.export_dirs : [],
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
        for (const root of roots) addAllowedMediaDir(root.path);
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
  const exportDirs = [...new Set((options?.exportDirs || []).filter(Boolean))];
  const needsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
  const needsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
  if (needsSources && !rawDirs.length) {
    throw new Error("choose at least one Source file or folder");
  }
  if (needsProcessed && !exportDirs.length) {
    throw new Error("choose at least one image folder");
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

assetsIpc.register({ ipcMain, shell, commands: sidecarCommands, callSidecarJsonAsync, addAllowedMediaDir });

saveFileIpc.register({
  ipcMain, dialog,
  rootDir,
  writeImageWithSourceMetadata,
  addAllowedMediaDir,
});

// quick-register / collage-sources / delete-export-assets are in ipc/assets.js
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
    const raw = request.url.slice("media://".length);
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
    return net.fetch(pathToFileURL(resolved).toString());
  });

  prepareCatalogPath();
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();

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
