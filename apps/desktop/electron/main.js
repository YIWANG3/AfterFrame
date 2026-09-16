const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage, clipboard, nativeImage, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { sampleOriginalNames, copySampleOriginals, repairLegacySamplePreviews } = require("./sampleCatalog");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

// stdout/stderr are usually a pipe, and the reader can go away while we keep
// running: Playwright tearing down a test app, `npm run dev`'s concurrently
// exiting before Electron does, the launching terminal closing. Without an
// 'error' listener the next console.log — the renderer console forwarder in
// createWindow fires on EVERY renderer message — throws EPIPE as an uncaught
// exception, and Electron turns each one into a modal "Uncaught Exception"
// dialog. Swallow EPIPE only; anything else is still a real error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err?.code !== "EPIPE") throw err;
  });
}

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
  } catch {
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
const peopleIpc = require("./ipc/people");
const frameLogosIpc = require("./ipc/frameLogos");
const editorsIpc = require("./ipc/editors");
const settingsTransferIpc = require("./ipc/settingsTransfer");
const { createAgentRenderBridge } = require("./agentRender");
const watcherModule = require("./watcher");
const { createMcpServer } = require("./mcp/server");
const { createSidecarCommands } = require("./sidecar/commands");
const { createSidecarTransport } = require("./sidecar/transport");
const { createSettingsStore } = require("./settingsStore");
const { createCatalogState } = require("./catalog");
const { createImageMetadataWriter } = require("./imageMetadata");
const { createTaskStarters } = require("./tasks");

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

// Dev convenience: keychain-encrypted provider tokens saved by the PACKAGED
// app are unreadable from the dev binary (different Safe Storage keychain
// item), so in dev also load API keys from the repo-root .env — the sidecar
// providers already fall back to these env vars when no --api-key is passed.
// Never runs in the packaged app, and never overrides existing env.
if (!isPackaged) {
  try {
    const envFile = path.join(__dirname, "..", "..", "..", ".env");
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
    // Sidecar's Jimeng fallback reads the Volcengine names.
    if (!process.env.VOLC_ACCESSKEY && process.env.JIMENG_API_KEY) process.env.VOLC_ACCESSKEY = process.env.JIMENG_API_KEY;
    if (!process.env.VOLC_SECRETKEY && process.env.JIMENG_API_SECRET) process.env.VOLC_SECRETKEY = process.env.JIMENG_API_SECRET;
    // Ark (Seedream) — accept either name for the same key.
    if (!process.env.ARK_API_KEY && process.env.SEEDREAM_API_KEY) process.env.ARK_API_KEY = process.env.SEEDREAM_API_KEY;
  } catch { /* no .env — fine */ }
}

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

function getAppSettingsPath() {
  return path.join(app.getPath("userData"), "afterframe", "settings.json");
}

const settingsStore = createSettingsStore({ getAppSettingsPath });

function readAppSettings() {
  return settingsStore.readAppSettings();
}

function updateAppSettings(mutateFn) {
  return settingsStore.updateAppSettings(mutateFn);
}

// The one mutable "which catalog is open" value, plus the path rules around
// it — see ./catalog.js. Read it through catalog.path() / catalog.state();
// switching happens in switchCatalogTo below.
const catalog = createCatalogState({
  rootDir,
  sidecarSrc,
  isPackaged,
  configuredCatalogPath,
  getUserDataDir: () => app.getPath("userData"),
  readAppSettings,
});
const { scratchCatalogPath } = catalog;

// Locale: the main process owns it (persisted in settings.json) so the menu and
// the renderer never disagree. The renderer reads it synchronously at startup
// via the preload bridge (app:get-locale).
const SUPPORTED_LOCALES = ["en", "zh-CN"];
function getLocale() {
  const l = readAppSettings().locale;
  return SUPPORTED_LOCALES.includes(l) ? l : "en";
}
let currentLocale = getLocale();

function readCatalogSettings(catalogPath = catalog.path()) {
  return settingsStore.readCatalogSettings(catalogPath);
}

function updateCatalogSettings(mutateFn, catalogPath = catalog.path()) {
  return settingsStore.updateCatalogSettings(catalogPath, mutateFn);
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
    // Chromium ciphertext carries a v10/v11 magic prefix. If this IS
    // ciphertext and decryption failed (keychain access denied — e.g. the
    // re-authorization prompt after an Electron upgrade was dismissed),
    // returning it would send raw ciphertext to the provider as a "token"
    // and surface as a baffling 401. Report "no key" instead — actionable.
    const head = Buffer.from(stored, "base64").subarray(0, 3).toString("latin1");
    if (head === "v10" || head === "v11") {
      console.warn("[tokens] stored token is encrypted but keychain decryption failed; treating as unconfigured");
      return null;
    }
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
    const payload = await sidecarCommands.getProviderToken(provider);
    if (payload?.token) {
      const migrated = await setStoredProviderConfig(provider, payload);
      return migrated;
    }
  } catch (error) {
    console.warn("[ai-provider-token] migration lookup failed:", error);
  }
  return existing || null;
}

async function prepareCatalogPath() {
  console.log("[prepareCatalogPath] catalog:", catalog.path());
  if (!catalog.path()) return;
  fs.mkdirSync(catalog.path(), { recursive: true });
  if (!catalog.hasDb()) {
    console.log("[prepareCatalogPath] empty catalog, skipping sidecar migration");
    return;
  }
  try { await sidecarCommands.splitSharedAssets(); } catch (_) { /* best-effort */ }
  try { await sidecarCommands.repairResourceSets(); } catch (_) { /* best-effort */ }
  if (catalog.isSample()) {
    const repaired = await repairLegacySamplePreviews({
      catalogPath: catalog.path(), source: samplePhotosSource,
      transport: sidecarTransport, commands: sidecarCommands,
      getCatalogPath: catalog.path,
    });
    if (repaired) {
      const originals = sampleOriginalNames(samplePhotosSource)
        .map((name) => path.join(catalog.samplePath(), "photos", name)).filter((file) => fs.existsSync(file));
      if (originals.length) {
        // Resume an interrupted sample import without resurrecting originals
        // the user deliberately removed from this catalog.
        await startImportTask({ mode: "processed_only", imageDirs: originals, auto: true });
      }
    }
  }
}

// ── Sample catalog ──────────────────────────────────────────────────────────
// Bundled demo library for first-run exploration. Created on the user's first
// click (never silently on install, so demo photos are never mistaken for the
// user's own data) and reopened directly afterwards. It lives under userData —
// app-owned, apart from real catalogs — and the bundled photos are copied
// INSIDE the catalog folder, so resetting is one folder delete and the media
// allowlist covers them without extra roots.
const samplePhotosSource = isPackaged
  ? path.join(process.resourcesPath, "sample-photos")
  : path.join(__dirname, "..", "sample-photos");

async function openSampleCatalog({ reset = false } = {}) {
  const samplePath = catalog.samplePath();
  if (reset && fs.existsSync(samplePath)) {
    await sidecarTransport.withCatalogPaused(samplePath, () =>
      fs.promises.rm(samplePath, { recursive: true, force: true }));
  }
  // No DB yet means the catalog was never populated (or was reset / deleted
  // externally) — copy the bundled photos and import them. Both steps are
  // idempotent, so an interrupted first open self-heals on the next one.
  const fresh = !catalog.hasDbAt(samplePath);
  const photosDir = path.join(samplePath, "photos");
  let originals = [];
  if (fresh) {
    fs.mkdirSync(samplePath, { recursive: true });
    originals = copySampleOriginals(samplePhotosSource, photosDir);
  }
  await switchCatalogTo(samplePath);
  if (fresh) {
    await registerRoots("image", [photosDir]);
    await startImportTask({ mode: "processed_only", imageDirs: originals });
  }
  return { path: samplePath, fresh };
}

// Sidecar transport lives in ./sidecar/transport.js — resident process,
// one-shot fallback, secret handoff, detached jobs. Aliased here so the
// hundreds of existing call sites stay unchanged.
const sidecarTransport = createSidecarTransport({
  rootDir,
  sidecarSrc,
  isPackaged,
  resourcesPath: process.resourcesPath,
  getCatalogPath: catalog.path,
});
// Only the JSON entry point is bound here, and only to feed the verb layer
// below — nothing in main.js or the ipc/mcp modules assembles sidecar argv by
// hand any more (that invariant is what keeps the three call surfaces from
// drifting apart again).
const callSidecarJsonAsync = sidecarTransport.callJsonAsync;
const launchSidecarJob = sidecarTransport.launchJob;
const stopResidentSidecar = sidecarTransport.stopResident;

// Domain-verb command layer — the only place argv is assembled. IPC handlers
// and MCP tools both receive this instead of building commands by hand.
const sidecarCommands = createSidecarCommands(callSidecarJsonAsync);

// Image write-back with the original's EXIF/XMP, and the background-task
// starters — both lived here until review 2026-09-16 §2. See ./imageMetadata.js
// and ./tasks.js; the module-level names below are what the ipc/mcp modules
// receive through their register() deps.
const { writeImageWithSourceMetadata } = createImageMetadataWriter({ rootDir, sidecarSrc, isPackaged });
const {
  formatJobStatus, latestJobStatus, createJob,
  startEnrichmentTask, startImportTask, startPreviewTask,
  startAiRepaintTask, startTextImageTask,
} = createTaskStarters({
  app,
  readAppSettings,
  commands: sidecarCommands,
  launchSidecarJob,
  addAllowedMediaDir,
  getStoredProviderConfigWithMigration,
});

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
      if (!catalog.path() || !catalog.hasDb()) return;
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
  if (catalog.path()) {
    const catalogCanonical = canonicalizeMediaPath(catalog.path());
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
    // Tahoe 皮肤:去掉系统标题栏,红绿灯落进侧栏面板(P3 第一步;渲染层让位 + 拖拽区在皮肤里)
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    // Tahoe gives a titlebar-only window the small (~16pt) corner; the large
    // 26pt corner is reserved for windows with an NSToolbar, which Electron
    // cannot create. So the window is transparent and the renderer clips
    // itself to a 26px rounded rect (index.css, html.electron #root); macOS
    // derives the shadow from the alpha shape.
    transparent: true,
    backgroundColor: "#00000000",
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
  for (const [evt, flag] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
    window.on(evt, () => { if (!window.isDestroyed()) window.webContents.send("window:fullscreen", flag); });
  }
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

function toggleAppFullscreen(browserWindow) {
  const window = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return;
  // Native macOS fullscreen immediately bounces a transparent BrowserWindow
  // back to windowed mode. Simple fullscreen is the supported equivalent for
  // our transparent Tahoe shell; other platforms keep the native behavior.
  const next = process.platform === "darwin"
    ? !window.isSimpleFullScreen()
    : !window.isFullScreen();
  if (process.platform === "darwin") window.setSimpleFullScreen(next);
  else window.setFullScreen(next);
  window.webContents.send("window:fullscreen", next);
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
        {
          id: "toggle-fullscreen",
          label: t("menu.toggleFullscreen"),
          accelerator: process.platform === "darwin" ? "Ctrl+Command+F" : "F11",
          click: (_item, browserWindow) => toggleAppFullscreen(browserWindow),
        },
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
  console.log("[ipc:summary] catalogPath:", catalog.path(), "hasDb:", catalog.hasDb());
  if (!catalog.path() || !catalog.hasDb()) {
    return { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  }
  try {
    return await sidecarCommands.summary() || { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  } catch (err) {
    console.warn("[workspace:summary] sidecar error:", err.message);
    return { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
  }
});

ipcMain.handle("workspace:roots", async () => {
  if (!catalog.path() || !catalog.hasDb()) return [];
  try {
    return await sidecarCommands.catalogRoots();
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

// Handwriting reference image (style-transfer source). The chosen file is fed
// to the text-image job as --ref-image; allow it through media:// so the modal
// can show a thumbnail.
ipcMain.handle("workspace:pick-handwriting-ref", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose reference image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  addAllowedMediaDir(path.dirname(filePath));
  return filePath;
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
  return catalog.createAt(result.filePath);
});

async function switchCatalogTo(nextCatalogPath) {
  console.log("[ipc:switch-catalog] nextCatalogPath:", nextCatalogPath, "scratchCatalogPath:", scratchCatalogPath);
  if (!nextCatalogPath && !scratchCatalogPath) {
    catalog.set(null);
    watcherApi?.rebuild?.();
    console.log("[ipc:switch-catalog] cleared catalog (packaged mode, no path)");
    stopResidentSidecar();
    return true;
  }
  catalog.set(catalog.normalize(nextCatalogPath || scratchCatalogPath) || scratchCatalogPath);
  watcherApi?.rebuild?.();
  console.log("[ipc:switch-catalog] catalog set to:", catalog.path());
  stopResidentSidecar(); // next sidecar call restarts it bound to the new catalog
  // Per-catalog caches must not leak across libraries: media allowlist roots,
  // the agent-facing selection mirror, and the MCP preview-path cache.
  resetMediaAllowlist();
  currentSelection = { assets: [], updatedAt: null };
  // Not `?.clearPreviewCache?.()` — the second optional chain silently no-ops
  // when the method goes missing, which is exactly how this leak survived.
  mcpServerApi?.clearPreviewCache();
  await prepareCatalogPath();
  void peopleApi?.recoverQueuedPeopleJobs?.();
  // Persist last catalog path for next launch
  if (catalog.path()) {
    await updateAppSettings((s) => ({ ...s, lastCatalogPath: catalog.path() }));
  }
  return true;
}

ipcMain.handle("workspace:switch-catalog", (_event, nextCatalogPath) => switchCatalogTo(nextCatalogPath));

ipcMain.handle("workspace:open-sample-catalog", () => openSampleCatalog());

ipcMain.handle("workspace:reset-sample-catalog", () => openSampleCatalog({ reset: true }));

editorsIpc.register({ ipcMain });

const watcherApi = watcherModule.register({
  ipcMain,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getCatalogPath: catalog.path,
  readCatalogSettings,
  updateCatalogSettings,
});

let peopleApi = null;

jobsIpc.register({
  ipcMain,
  getCatalogState: catalog.state,
  formatJobStatus, latestJobStatus,
  startImportTask, startEnrichmentTask, startPreviewTask,
  commands: sidecarCommands,
  resumePeopleIndexJob: (jobId) => peopleApi?.resumePeopleIndexJob(jobId),
});

aiIpc.register({
  app, ipcMain,
  commands: sidecarCommands,
  getCatalogState: catalog.state,
  readAppSettings, updateAppSettings,
  getStoredProviderConfigWithMigration, setStoredProviderConfig, deleteStoredProviderConfig,
  startAiRepaintTask, startTextImageTask, latestJobStatus, formatJobStatus,
});

const annotationApi = annotationIpc.register({
  ipcMain,
  commands: sidecarCommands,
  getCatalogState: catalog.state,
  readAppSettings, updateAppSettings,
  getStoredProviderConfigWithMigration, setStoredProviderConfig, deleteStoredProviderConfig,
  createJob, launchSidecarJob, latestJobStatus, formatJobStatus,
});

peopleApi = peopleIpc.register({
  app, ipcMain, dialog,
  isPackaged,
  resourcesPath: process.resourcesPath,
  readAppSettings, updateAppSettings,
  getCatalogState: catalog.state,
  createJob, launchSidecarJob, latestJobStatus, formatJobStatus,
  commands: sidecarCommands,
});

browseIpc.register({
  ipcMain,
  commands: sidecarCommands,
  getCatalogState: catalog.state,
});

assetsIpc.register({
  ipcMain, shell, dialog, BrowserWindow,
  commands: sidecarCommands, addAllowedMediaDir,
  getCatalogState: catalog.state,
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
async function applyLocale(lng) {
  if (!SUPPORTED_LOCALES.includes(lng)) return currentLocale;
  await updateAppSettings((s) => ({ ...s, locale: lng }));
  currentLocale = lng;
  Menu.setApplicationMenu(buildAppMenu());
  return currentLocale;
}
ipcMain.handle("app:set-locale", (_event, lng) => applyLocale(lng));

settingsTransferIpc.register({
  app, ipcMain, dialog,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getAppSettingsPath, readAppSettings, updateAppSettings,
  decryptToken, setStoredProviderConfig,
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  applyLocale,
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
ipcMain.handle("app:save-preview-settings", async (_event, next) => {
  const persisted = await updateAppSettings((s) => ({
    ...s,
    previews: { ...(s?.previews || {}), ...(next || {}) },
  }));
  return persisted.previews ?? {};
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

const saveFileApi = saveFileIpc.register({
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

ipcMain.handle("workspace:info", () => catalog.info());
// The renderer owns the theme (dark / light / system). Mirror it into the
// window's native appearance so macOS draws the traffic lights — and their
// inactive grey state — for the right background; otherwise a light UI gets
// the dark-appearance lights, which are near-white when the window is inactive.
ipcMain.handle("workspace:set-theme", (_event, theme) => {
  nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
  return nativeTheme.themeSource;
});

// --- Collections ---

collectionsIpc.register({
  ipcMain,
  commands: sidecarCommands,
  getCatalogState: catalog.state,
});

// Native OS drag-out: the renderer preventDefault()s the HTML5 dragstart and
// asks us to start a real OS drag session carrying file paths. The OS then
// handles every drop target for free — Finder copies the files, browsers /
// chat apps treat them as uploads. startDrag initiates the OS session but its
// return is not a drag-finished signal; the renderer clears its source marker
// from real input/window lifecycle events.
// Electron starts one NSDraggingItem per file, every one carrying the same
// icon at the same frame. macOS draws them all, so a 68-file drag stacks 68
// copies of one opaque thumbnail — the pile goes black and grows a heavy
// shadow halo. Pre-fade the icon so the N stacked copies composite back to
// one normal-looking image: per-copy alpha a with 1 − (1 − a)^N ≈ 0.92.
// Bitmap data round-trips premultiplied, so every channel scales together.
// The 192px source is re-wrapped at scaleFactor 2 → a sharp 96pt icon.
function pileSafeDragIcon(icon, count) {
  const size = icon.getSize();
  if (!size.width || !size.height) return icon;
  const alpha = count > 1 ? 1 - Math.pow(1 - 0.92, 1 / count) : 1;
  const bitmap = Buffer.from(icon.toBitmap());
  if (alpha < 1) for (let i = 0; i < bitmap.length; i++) bitmap[i] = Math.round(bitmap[i] * alpha);
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 2 });
}

ipcMain.handle("workspace:native-drag", (event, payload) => {
  const files = (Array.isArray(payload?.files) ? payload.files : [])
    .filter((p) => typeof p === "string" && p && fs.existsSync(p));
  if (!files.length) return { ok: false, reason: "no-files" };

  // macOS requires a drag icon. Prefer the item's preview (RAW originals
  // don't decode via nativeImage); fall back through the files themselves.
  let icon = nativeImage.createEmpty();
  const iconCandidates = [payload?.iconPath, ...files].filter(Boolean);
  for (const candidate of iconCandidates) {
    icon = nativeImage.createFromPath(candidate);
    if (!icon.isEmpty()) break;
  }
  if (!icon.isEmpty()) {
    icon = pileSafeDragIcon(icon.resize({ width: 192 }), files.length);
  } else {
    // 1x1 transparent px — startDrag rejects an empty image on macOS.
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    );
  }

  event.sender.startDrag({ files, icon });
  return { ok: true, count: files.length };
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

app.whenReady().then(async () => {
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

  const catalogPreparation = prepareCatalogPath().finally(() => {
    // A paused task remains paused; only queued durable people tasks are
    // resumed after an app restart. The runner uses its cursor and model path
    // stored in the task payload, so it cannot silently switch model spaces.
    void peopleApi?.recoverQueuedPeopleJobs?.();
  });
  // A saved sample catalog can be reopened without the welcome action. Finish
  // its targeted migration before the first gallery query sees legacy previews.
  if (catalog.isSample()) {
    await catalogPreparation.catch((err) => console.warn("[sample] repair failed:", err.message));
  }
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();
  try { watcherApi.start(); } catch (err) { console.warn("[watcher] start failed:", err?.message || err); }

  // Embedded MCP server — external AI agents (Claude Code etc.) drive the app
  // through this while it runs. Failures must never affect the app itself.
  mcpServerApi = createMcpServer({
    getCatalogState: catalog.state,
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
    processAndSave: saveFileApi.processAndSave,
    watcher: watcherApi,
    askRenderer: createAgentRenderBridge({ BrowserWindow, ipcMain }).askRenderer,
    // Arrow-wrapped: peopleApi is assigned after this module-level wiring runs.
    startPeopleIndex: (options) => peopleApi?.startPeopleIndex(options),
    resumePeopleIndexJob: (jobId) => peopleApi?.resumePeopleIndexJob(jobId),
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
