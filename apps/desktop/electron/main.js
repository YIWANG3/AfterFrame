const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, safeStorage, clipboard, nativeImage, nativeTheme, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

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
const sharp = require("sharp");

const { makeT } = require("./i18n");
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
const frameTemplatesIpc = require("./ipc/frameTemplates");
const lutsIpc = require("./ipc/luts");
const editorsIpc = require("./ipc/editors");
const settingsTransferIpc = require("./ipc/settingsTransfer");
const dialogsIpc = require("./ipc/dialogs");
const appSettingsIpc = require("./ipc/appSettings");
const systemFontsIpc = require("./ipc/systemFonts");
const videoIpc = require("./ipc/video");
const nativeDragIpc = require("./ipc/nativeDrag");
const nativeVideoIpc = require("./ipc/nativeVideo");
const { importableRoots } = require("./importRoots");
const { createAgentBridge } = require("./agentBridge");
const watcherModule = require("./watcher");
const { createMcpServer } = require("./mcp/server");
const { createSidecarCommands } = require("./sidecar/commands");
const { createSidecarTransport } = require("./sidecar/transport");
const { createSettingsStore } = require("./settingsStore");
const { createCatalogState } = require("./catalog");
const { createSampleCatalog } = require("./sampleCatalog");
const { IPC_METHODS } = require("../shared/ipcChannels.mjs");
const { createImageMetadataWriter } = require("./imageMetadata");
const { createTaskStarters } = require("./tasks");
const { createTokenStore } = require("./tokens");
const { createMediaAllowlist } = require("./media/allowlist");
const { registerMediaProtocol } = require("./media/protocol");
const { createMediaHttpServer } = require("./media/httpServer");
const { createAppShell } = require("./appShell");
const { desktopCapabilities } = require("./capabilities");
const { createHost, createServices } = require("./host");
const { claimSingleInstance, launchPaths } = require("./singleInstance");
const { createLocale } = require("./locale");
const { loadDevEnv } = require("./devEnv");
const clipboardIpc = require("./ipc/clipboard");

// Test isolation: when AFTERFRAME_USER_DATA is set, redirect userData to that
// directory so E2E tests get a clean catalog/settings/sticker library per run.
// Must happen before any code reads app.getPath("userData").
if (process.env.AFTERFRAME_USER_DATA) {
  app.setPath("userData", process.env.AFTERFRAME_USER_DATA);
}

// One instance per userData on Windows and Linux (./singleInstance.js; the
// lock lives in userData, so it's taken after the override above). A later
// launch hands its files to this one, which comes forward and imports them;
// the later launch quits before anything starts (see whenReady).
const isFirstInstance = claimSingleInstance({
  app,
  onSecondInstance: (paths) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    for (const file of paths) appShell.queueExternalImport(file);
  },
});
if (!isFirstInstance) app.quit();

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

// Dev: provider API keys from the repo-root .env — see ./devEnv.js.
if (!isPackaged) loadDevEnv(path.join(__dirname, "..", "..", "..", ".env"));

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
// Bundled helpers and data: in extraResources when packaged, in the repo in dev.
const resourceDir = (...parts) => (isPackaged ? path.join(process.resourcesPath, ...parts) : null);
const sidecarSrc = resourceDir("sidecar", "src") || path.join(rootDir, "services", "sidecar", "src");
const nativeBin = resourceDir("native", "bin") || path.join(rootDir, "apps", "desktop", "native", "bin");
const samplePhotosSource = resourceDir("sample-photos") || path.join(__dirname, "..", "sample-photos");

function getAppSettingsPath() {
  return path.join(app.getPath("userData"), "afterframe", "settings.json");
}

const settingsStore = createSettingsStore({ getAppSettingsPath });
const readAppSettings = () => settingsStore.readAppSettings();
const updateAppSettings = (mutateFn) => settingsStore.updateAppSettings(mutateFn);

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

// The UI language — see ./locale.js. Setting it rebuilds the menu.
const locale = createLocale({ ipcMain, readAppSettings, updateAppSettings, onChange: () => appShell.installMenu() });
const t = () => makeT(locale.current());

const readCatalogSettings = (catalogPath = catalog.path()) => settingsStore.readCatalogSettings(catalogPath);
const updateCatalogSettings = (mutateFn, catalogPath = catalog.path()) => settingsStore.updateCatalogSettings(catalogPath, mutateFn);

// Provider tokens at rest (keychain via safeStorage, legacy migrations) —
// see ./tokens.js. The sidecar verb layer is defined further down; the
// fallback only runs at call time, long after it exists.
const tokens = createTokenStore({
  safeStorage,
  readAppSettings,
  updateAppSettings,
});
const { providerCredentials } = tokens;

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

// Sidecar transport lives in ./sidecar/transport.js — resident process,
// one-shot fallback, secret handoff, detached jobs.
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
const launchSidecarJob = sidecarTransport.launchJob;
const stopResidentSidecar = sidecarTransport.stopResident;

// Domain-verb command layer — the only place argv is assembled. IPC handlers
// and MCP tools both receive this instead of building commands by hand.
const sidecarCommands = createSidecarCommands(sidecarTransport.callJsonAsync, sidecarTransport.callJsonOneShot);

// Image write-back with the original's EXIF/XMP, and the background-task
// starters — see ./imageMetadata.js and ./tasks.js. Both reach the ipc/mcp
// modules through the host built below.
const { writeImageWithSourceMetadata } = createImageMetadataWriter({
  readSourceMetadata: (sourcePath) => sidecarCommands.readImageMetadata(sourcePath),
});
// The apis registered modules hand to the ones after them — see ./host.js.
const services = createServices();
const tasks = createTaskStarters({
  app,
  readAppSettings,
  commands: sidecarCommands,
  launchSidecarJob,
  addAllowedMediaDir,
  providerCredentials,
  // people registers after the task starters exist; read it at call time.
  resumePeopleIndexJob: (jobId) => services.people?.resumePeopleIndexJob(jobId),
});
const { startImportTask } = tasks;

async function registerRoots(rootType, paths) {
  // A dropped file the catalog doesn't import is no root (the import's
  // summary counts it as skipped); folders are, whatever they hold.
  const uniquePaths = importableRoots([...new Set((paths || []).filter(Boolean))]);
  if (!uniquePaths.length) {
    return [];
  }
  for (const targetPath of uniquePaths) addAllowedMediaDir(targetPath);
  return await sidecarCommands.registerRoots(rootType, uniquePaths);
}

// Agent ↔ app window: the selection mirror, catalog-changed broadcasts, reveal
// and in-renderer rendering — see ./agentBridge.js.
const agentBridge = createAgentBridge({ BrowserWindow, ipcMain });

// Window, application menu, fullscreen and the open-file queue — see
// ./appShell.js. The menu re-renders from getLocale on every install.
const appShell = createAppShell({
  BrowserWindow, Menu, makeT,
  getLocale: locale.current,
  devServerUrl,
  preloadPath: path.join(__dirname, "preload.js"),
  indexHtml: path.join(__dirname, "..", "dist", "index.html"),
  screen, nativeTheme,
  getShortcuts: () => readAppSettings()?.shortcuts || {},
});
const getMainWindow = () => BrowserWindow.getAllWindows()[0] || null;

// Windows title strip (WindowTitleBar.jsx): its menu button, and the caption
// buttons' colour following the app theme. No-ops on macOS.
ipcMain.handle("window:popup-app-menu", (event, x, y) =>
  appShell.popupAppMenu(BrowserWindow.fromWebContents(event.sender), x, y));
ipcMain.handle("window:set-titlebar-theme", (event, theme) =>
  appShell.setTitleBarTheme(BrowserWindow.fromWebContents(event.sender), theme));

// The sample catalog and the open-time self-repair every catalog gets — see
// ./sampleCatalog.js. switchCatalogTo stays here (./catalog.js header).
const sample = createSampleCatalog({
  catalog, source: samplePhotosSource,
  transport: sidecarTransport, commands: sidecarCommands,
  startImportTask, switchCatalogTo, registerRoots,
});

async function switchCatalogTo(nextCatalogPath) {
  console.log("[ipc:switch-catalog] nextCatalogPath:", nextCatalogPath, "scratchCatalogPath:", scratchCatalogPath);
  if (!nextCatalogPath && !scratchCatalogPath) {
    catalog.set(null);
    services.watcher?.rebuild?.();
    console.log("[ipc:switch-catalog] cleared catalog (packaged mode, no path)");
    stopResidentSidecar();
    return true;
  }
  catalog.set(catalog.normalize(nextCatalogPath || scratchCatalogPath) || scratchCatalogPath);
  services.watcher?.rebuild?.();
  console.log("[ipc:switch-catalog] catalog set to:", catalog.path());
  stopResidentSidecar(); // next sidecar call restarts it bound to the new catalog
  // Per-catalog caches must not leak across libraries: media allowlist roots,
  // the agent-facing selection mirror, and the MCP preview-path cache.
  resetMediaAllowlist();
  agentBridge.clearSelection();
  // Not `?.clearPreviewCache?.()` — the second optional chain silently no-ops
  // when the method goes missing, which is exactly how this leak survived.
  services.mcp?.clearPreviewCache();
  await sample.prepareCatalogPath();
  void services.people?.recoverQueuedPeopleJobs?.();
  // Persist last catalog path for next launch
  if (catalog.path()) {
    await updateAppSettings((s) => ({ ...s, lastCatalogPath: catalog.path() }));
  }
  return true;
}

ipcMain.handle("workspace:switch-catalog", (_event, nextCatalogPath) => switchCatalogTo(nextCatalogPath));
ipcMain.handle("workspace:open-sample-catalog", () => sample.openSampleCatalog());
ipcMain.handle("workspace:reset-sample-catalog", () => sample.openSampleCatalog({ reset: true }));
ipcMain.handle("workspace:register-roots", (_event, rootType, paths) => registerRoots(rootType, paths));

const dialogs = dialogsIpc.createDialogs({ dialog, BrowserWindow });

// Everything a register(host) can reach — ./host.js lists it and says why it
// is frozen. Built once, here, after every part above exists; the modules
// below destructure what they use.
const host = createHost({
  app, ipcMain, dialog, shell, BrowserWindow, nativeImage, clipboard, sharp,
  platform: process.platform, isPackaged, rootDir, resourcesPath: process.resourcesPath, nativeBin, sidecarSrc,
  getUserDataPath: () => app.getPath("userData"), t,
  getAppSettingsPath, readAppSettings, updateAppSettings, readCatalogSettings, updateCatalogSettings,
  catalog, commands: sidecarCommands, launchSidecarJob, registerRoots,
  tasks, tokens, media, mediaHttp,
  getMainWindow, appShell, locale, agentBridge,
  dialogs, writeImageWithSourceMetadata,
  services,
});

dialogsIpc.register(host);
editorsIpc.register(host);
services.set("watcher", watcherModule.register(host));
jobsIpc.register(host);
aiIpc.register(host);
services.set("annotation", annotationIpc.register(host));
services.set("people", peopleIpc.register(host));
browseIpc.register(host);
assetsIpc.register(host);

ipcMain.on("app:get-media-port", (event) => {
  event.returnValue = mediaHttp.port();
});

settingsTransferIpc.register(host);
// Cache folders, preview settings, shortcuts, menu accelerators — see
// ./ipc/appSettings.js.
appSettingsIpc.register(host);
// macOS plays originals with AVPlayer — see ./ipc/nativeVideo.js.
nativeVideoIpc.register(host);
// Playback proxy + keyframe filmstrip — see ./ipc/video.js.
videoIpc.register(host);
// Dev only: tells the renderer when electron/, shared/, features/ or the
// sidecar's sources are newer than this process (see electron/devStaleness.js).
require("./devStaleness").register(host);

// What this platform can do (api.can in the renderer); read once by preload.
ipcMain.on("app:capabilities", (event) => {
  event.returnValue = desktopCapabilities(process.platform, { hasHelper: (name) => fs.existsSync(path.join(nativeBin, name)) });
});

// The clipboard: text (paths, names) and, like Finder, the selected photos as
// files — see ./ipc/clipboard.js.
clipboardIpc.register(host);

// Settings → Integrations: where agents connect, and whether the server came up.
ipcMain.handle("app:mcp-status", () => services.mcp?.getStatus() ?? { status: "starting" });

services.set("saveFile", saveFileIpc.register(host));
frameLogosIpc.register(host);
frameTemplatesIpc.register(host);
lutsIpc.register(host);

// vibepin (dev only): pixel-perfect element/region screenshots for annotations.
// The overlay calls window.__vibepinCapture(rect) → this handler → capturePage.
if (devServerUrl) {
  ipcMain.handle("annotate:capture", async (event, rect) => {
    const img = await event.sender.capturePage(rect);
    return img.toDataURL();
  });
}

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

collectionsIpc.register(host);
// Native OS drag-out — see ./ipc/nativeDrag.js.
nativeDragIpc.register(host);
systemFontsIpc.register(host);
depthIpc.register(host);
stickerIpc.register(host);

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  appShell.queueExternalImport(filePath);
});

app.whenReady().then(async () => {
  if (!isFirstInstance) return;
  // Baseline allowlist entries that don't depend on the catalog. The whole
  // userData dir is app-owned (settings, sticker library, depth-cache …) —
  // allowing only the afterframe/ subdir broke depth-field loading.
  addBaselineMediaDir(app.getPath("userData"));
  if (!isPackaged) addBaselineMediaDir(rootDir); // dev fixtures / demo assets

  // media:// (images; HEIF, PSD and TIFF originals rendered to JPEG on the
  // fly, cached under userData) — see ./media/protocol.js.
  registerMediaProtocol({
    protocol, net, allowlist: media, cacheDir: path.join(app.getPath("userData"), "transcode-cache"),
    // No sips off macOS: the sidecar converts with Pillow + pillow-heif.
    convert: process.platform === "darwin" ? undefined : (src, out, options) => sidecarCommands.transcodeImage(src, out, options),
  });
  // Up to 0.5.14 the renders lived in the temp folder, which Windows never empties.
  fs.rm(path.join(os.tmpdir(), "afterframe-heic-cache"), { recursive: true, force: true }, () => {});

  const catalogPreparation = sample.prepareCatalogPath().finally(() => {
    // A paused task remains paused; only queued durable people tasks are
    // resumed after an app restart. The runner uses its cursor and model path
    // stored in the task payload, so it cannot silently switch model spaces.
    void services.people?.recoverQueuedPeopleJobs?.();
  });
  // A saved sample catalog can be reopened without the welcome action. Finish
  // its targeted migration before the first gallery query sees legacy previews.
  if (catalog.isSample()) {
    await catalogPreparation.catch((err) => console.warn("[sample] repair failed:", err.message));
  }
  appShell.installMenu();
  appShell.createWindow();
  // Files this launch was opened with: on Windows and Linux they arrive as
  // arguments (dropped on the .exe, "Open with"); macOS sends open-file.
  if (process.platform !== "darwin") {
    for (const file of launchPaths(process.argv, { defaultApp: Boolean(process.defaultApp) })) {
      appShell.queueExternalImport(file);
    }
  }
  try { services.watcher.start(); } catch (err) { console.warn("[watcher] start failed:", err?.message || err); }

  // Embedded MCP server — external AI agents (Claude Code etc.) drive the app
  // through this while it runs. Failures must never affect the app itself.
  services.set("mcp", createMcpServer(host, {
    // Dev and packaged builds get DIFFERENT default ports so running both at
    // once never collides — and agents deterministically reach the instance
    // they were configured for (repo .mcp.json → dev :41707; user-scope
    // registration → release :41706). Env var still overrides both.
    port: Number(process.env.AFTERFRAME_MCP_PORT) || (isPackaged ? 41706 : 41707),
  }));
  services.mcp.start();

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
