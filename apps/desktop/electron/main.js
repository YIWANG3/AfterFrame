const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage, clipboard, nativeImage, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { sampleOriginalNames, copySampleOriginals, repairLegacySamplePreviews } = require("./sampleCatalog");

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
const { IPC_METHODS } = require("../shared/ipcChannels.mjs");
const { createImageMetadataWriter } = require("./imageMetadata");
const { createTaskStarters } = require("./tasks");
const { createTokenStore } = require("./tokens");
const { createMediaAllowlist } = require("./media/allowlist");
const { registerMediaProtocol } = require("./media/protocol");
const { createMediaHttpServer } = require("./media/httpServer");
const { createAppShell } = require("./appShell");
const videoIpc = require("./ipc/video");
const nativeDragIpc = require("./ipc/nativeDrag");

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

// Provider tokens at rest (keychain via safeStorage, legacy migrations) —
// see ./tokens.js. The sidecar verb layer is defined further down; the
// fallback only runs at call time, long after it exists.
const tokens = createTokenStore({
  safeStorage,
  readAppSettings,
  updateAppSettings,
  fetchLegacyToken: (provider) => sidecarCommands.getProviderToken(provider),
});
const { decryptToken, setStoredProviderConfig, deleteStoredProviderConfig, getStoredProviderConfigWithMigration } = tokens;

// media:// allowlist — see ./media/allowlist.js. Created before the task
// starters and ipc modules that take addAllowedMediaDir; catalog roots load
// lazily through the verb layer defined below.
const media = createMediaAllowlist({
  getCatalogPath: catalog.path,
  catalogHasDb: catalog.hasDb,
  loadCatalogRoots: () => sidecarCommands.catalogRoots(),
});
const { addAllowedMediaDir, addBaselineMediaDir, resetMediaAllowlist } = media;
// Localhost range server for <video> (media:// stays image-only).
const mediaHttp = createMediaHttpServer({ allowlist: media });

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

// Window, application menu, fullscreen and the open-file queue — see
// ./appShell.js. The menu re-renders from getLocale on every install.
const appShell = createAppShell({
  BrowserWindow, Menu, makeT,
  getLocale: () => currentLocale,
  devServerUrl,
  preloadPath: path.join(__dirname, "preload.js"),
  indexHtml: path.join(__dirname, "..", "dist", "index.html"),
});

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
  event.returnValue = mediaHttp.port();
});
async function applyLocale(lng) {
  if (!SUPPORTED_LOCALES.includes(lng)) return currentLocale;
  await updateAppSettings((s) => ({ ...s, locale: lng }));
  currentLocale = lng;
  appShell.installMenu();
  return currentLocale;
}
ipcMain.handle("app:set-locale", (_event, lng) => applyLocale(lng));

settingsTransferIpc.register({
  app, ipcMain, dialog,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getAppSettingsPath, readAppSettings, updateAppSettings,
  decryptToken, setStoredProviderConfig,
  isEncryptionAvailable: tokens.isEncryptionAvailable,
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

// Playback proxy + keyframe filmstrip — see ./ipc/video.js.
videoIpc.register({
  ipcMain, app, allowlist: media,
  videoToolPath: isPackaged
    ? path.join(process.resourcesPath, "native", "bin", "video-tool")
    : path.join(rootDir, "apps", "desktop", "native", "bin", "video-tool"),
});

// Copy arbitrary text (asset paths/names) to the system clipboard. Done in the
// main process so it works regardless of renderer focus / gesture state.
ipcMain.handle("app:copy-text", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

// Settings → Integrations: where agents connect, and whether the server came up.
ipcMain.handle("app:mcp-status", () => mcpServerApi?.getStatus() ?? { status: "starting" });

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
// The preload is sandboxed and cannot require shared/ipcChannels.mjs itself;
// it asks for the rows synchronously and builds its invoke bindings from them.
ipcMain.on("app:ipc-methods", (event) => { event.returnValue = IPC_METHODS; });

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

// Native OS drag-out — see ./ipc/nativeDrag.js.
nativeDragIpc.register({ ipcMain, nativeImage });

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

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  appShell.queueExternalImport(filePath);
});

app.whenReady().then(async () => {
  // Baseline allowlist entries that don't depend on the catalog. The whole
  // userData dir is app-owned (settings, sticker library, depth-cache …) —
  // allowing only the afterframe/ subdir broke depth-field loading.
  const heicCacheDir = path.join(os.tmpdir(), "afterframe-heic-cache");
  addBaselineMediaDir(heicCacheDir);
  addBaselineMediaDir(app.getPath("userData"));
  if (!isPackaged) addBaselineMediaDir(rootDir); // dev fixtures / demo assets

  // media:// (images; HEIC transcoded on the fly) — see ./media/protocol.js.
  registerMediaProtocol({ protocol, net, allowlist: media, heicCacheDir });

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
  appShell.installMenu();
  appShell.createWindow();
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
      appShell.createWindow();
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
