// In-app updates (Settings ▸ About, AfterFrame ▸ Check for Updates…):
// electron-updater checks, downloads and installs a new version
// (docs/auto-update.md).
//
// Where it looks is baked into each app at build time: electron-builder writes
// package.json's build.publish into Resources/app-update.yml, and each Mac
// build has its own channel there (electron-builder.mac.cjs). So the
// Apple-silicon macOS 14 app reads `latest-mac.yml`, a macOS 12 app reads
// `macos12-arm64-mac.yml` or `macos12-intel-mac.yml`, Windows reads
// `latest.yml`, all from the latest GitHub release (scripts/release.sh and
// the Windows workflow upload them). electron-updater only tells builds apart
// by CPU, so without the channels a macOS 12 Mac could be offered the
// macOS 14 app.
//
// The renderer sees one state object, pushed on every change:
//   idle → checking → current | available → downloading → ready
// and error from any of them, with the stage that failed. A check the app
// made by itself that fails goes back to what it was: being offline is not
// something to show in Settings.
//
// Unasked, the app only checks: a minute after launch and then once a day,
// unless Settings ▸ About ▸ Check automatically is off. Downloading waits for
// a click (the Apple-silicon app is about 400 MB). Once it is downloaded,
// Squirrel.Mac or the NSIS installer puts it in place when the app quits, or
// straight away on Restart to Update.

const fs = require("node:fs");
const path = require("node:path");

const RELEASES_URL = "https://github.com/YIWANG3/AfterFrame/releases";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;

// electron-updater sends an id it makes up and keeps in userData with every
// request (x-user-staging-id, for staged rollouts, which AfterFrame doesn't
// do). Every install sends this one instead, so a check says nothing about
// which install made it (site/privacy.html).
const SHARED_STAGING_ID = "00000000-0000-0000-0000-000000000000";

// No update info for this build in the latest release: the Windows installer
// is uploaded a while after the Mac release goes up. Nothing to update to yet.
const NO_UPDATE_INFO = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

// Why this copy of the app can't replace itself, or null if it can. Squirrel.Mac
// swaps the .app in its folder, so the folder must be writable: a DMG is
// read-only, and an app opened where it was downloaded runs from a read-only
// translocated copy. Windows installs per user and the installer elevates if
// it must.
function installBlocker({ platform, execPath, canWrite }) {
  if (platform !== "darwin") return null;
  if (execPath.includes("/AppTranslocation/")) return "location";
  const bundle = execPath.split(".app/Contents/")[0];
  if (bundle === execPath) return null; // not in a bundle: a dev run
  return canWrite(path.dirname(`${bundle}.app`)) ? null : "location";
}

function canWriteDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function createUpdater({
  app,
  ipcMain,
  BrowserWindow,
  readAppSettings,
  updateAppSettings,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  canWrite = canWriteDir,
  loadAutoUpdater = () => require("electron-updater").autoUpdater,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
}) {
  // AFTERFRAME_UPDATE_FEED points the app at another feed: the e2e spec's local
  // server, or a folder served by hand to try an update before a release.
  const feedOverride = env.AFTERFRAME_UPDATE_FEED || "";
  const supported = Boolean(feedOverride) || (app.isPackaged && (platform === "darwin" || platform === "win32"));
  // Under e2e (AFTERFRAME_USER_DATA) a packaged app doesn't check GitHub by
  // itself; a spec that wants it gives a feed.
  const autoCheckAllowed = supported && (Boolean(feedOverride) || !env.AFTERFRAME_USER_DATA);
  const firstCheckDelayMs = Number(env.AFTERFRAME_UPDATE_CHECK_DELAY_MS) || FIRST_CHECK_DELAY_MS;
  const blocker = supported ? installBlocker({ platform, execPath, canWrite }) : null;

  let updater = null;
  let state = { status: "idle", version: null, percent: null, error: null, background: false };
  // What electron-updater is doing, for an error to say which step failed:
  // "check", "download", or "install" (Squirrel.Mac unpacks the download and
  // checks its signature right after it lands).
  let phase = "check";
  let checkingInBackground = false;
  let stateBeforeCheck = null;
  let timer = null;

  const autoCheck = () => readAppSettings()?.updates?.autoCheck !== false;

  function snapshot() {
    return {
      supported,
      canInstall: supported && !blocker,
      blocker,
      currentVersion: app.getVersion(),
      arch: process.arch,
      autoCheck: autoCheck(),
      releasesUrl: `${RELEASES_URL}/latest`,
      releaseUrl: state.version ? `${RELEASES_URL}/tag/v${state.version}` : `${RELEASES_URL}/latest`,
      ...state,
    };
  }

  function set(next) {
    state = { ...state, ...next };
    const payload = snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("app:update-changed", payload);
    }
  }

  function writeFeedOverride(autoUpdater) {
    const dir = path.join(app.getPath("userData"), "update-feed");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "app-update.yml");
    // Downloads go to <OS cache folder>/<updaterCacheDirName>; a name that
    // walks back to this folder keeps a test's download in its own userData.
    const cacheName = path.relative(autoUpdater.app.baseCachePath, path.join(dir, "cache"));
    const config = {
      provider: "generic",
      url: feedOverride,
      channel: env.AFTERFRAME_UPDATE_CHANNEL || "latest",
      updaterCacheDirName: cacheName,
    };
    // JSON is YAML; electron-updater reads the file with js-yaml.
    fs.writeFileSync(configPath, JSON.stringify(config));
    autoUpdater.updateConfigPath = configPath;
    // An unpackaged app has no app-update.yml and electron-updater skips it.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  }

  function ensureUpdater() {
    if (updater) return updater;
    const autoUpdater = loadAutoUpdater();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (...args) => log.log("[updater]", ...args),
      warn: (...args) => log.warn("[updater]", ...args),
      error: (...args) => log.warn("[updater]", ...args),
    };
    autoUpdater.stagingUserIdPromise = { value: Promise.resolve(SHARED_STAGING_ID) };
    if (feedOverride) writeFeedOverride(autoUpdater);

    autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
    autoUpdater.on("update-not-available", () => set({ status: "current", version: null, percent: null, background: false }));
    autoUpdater.on("update-available", (info) => set({
      status: "available", version: info?.version || null, percent: null, background: checkingInBackground,
    }));
    autoUpdater.on("download-progress", (progress) => set({
      status: "downloading", percent: Math.max(0, Math.min(100, Math.round(progress?.percent || 0))),
    }));
    autoUpdater.on("update-downloaded", (info) => {
      phase = "install";
      set({ status: "ready", version: info?.version || state.version, percent: 100 });
    });
    autoUpdater.on("error", (error) => onError(error));
    updater = autoUpdater;
    return updater;
  }

  function onError(error) {
    if (phase === "check" && error?.code === NO_UPDATE_INFO) {
      set({ status: "current", version: null, error: null, background: false });
    } else if (phase === "check" && checkingInBackground) {
      set({ ...stateBeforeCheck, error: null });
    } else {
      set({ status: "error", error: { stage: phase, message: String(error?.message || error).split("\n")[0] } });
    }
  }

  async function check({ background = false } = {}) {
    if (!supported) return snapshot();
    if (state.status === "checking" || state.status === "downloading" || state.status === "ready") return snapshot();
    const autoUpdater = ensureUpdater();
    phase = "check";
    checkingInBackground = background;
    stateBeforeCheck = { status: state.status, version: state.version, percent: state.percent, background: state.background };
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the "error" event.
    } finally {
      checkingInBackground = false;
    }
    return snapshot();
  }

  async function download() {
    const retry = state.status === "error" && state.error?.stage === "download";
    if (!supported || blocker || !(state.status === "available" || retry)) return snapshot();
    const autoUpdater = ensureUpdater();
    phase = "download";
    set({ status: "downloading", percent: 0, error: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // Reported through the "error" event.
    }
    return snapshot();
  }

  function install() {
    if (state.status !== "ready" || !updater) return false;
    // Silent, and the app opens again afterwards (Windows; Squirrel.Mac
    // always relaunches).
    setImmediate(() => updater.quitAndInstall(true, true));
    return true;
  }

  function scheduleNext(delay) {
    if (timer) clearTimer(timer);
    timer = null;
    if (!autoCheckAllowed || !autoCheck()) return;
    timer = setTimer(() => {
      timer = null;
      void check({ background: true }).finally(() => scheduleNext(DAY_MS));
    }, delay);
    timer?.unref?.();
  }

  async function setAutoCheck(on) {
    await updateAppSettings((s) => ({ ...s, updates: { ...(s?.updates || {}), autoCheck: on !== false } }));
    scheduleNext(firstCheckDelayMs);
    set({});
    return snapshot();
  }

  function register() {
    ipcMain.handle("app:update-state", () => snapshot());
    ipcMain.handle("app:update-check", () => check());
    ipcMain.handle("app:update-download", () => download());
    ipcMain.handle("app:update-install", () => install());
    ipcMain.handle("app:update-auto-check", (_event, on) => setAutoCheck(on));
  }

  // After the window is up: the first check waits a minute so it never
  // competes with opening the catalog.
  function start() {
    scheduleNext(firstCheckDelayMs);
  }

  return { register, start, check, download, install, setAutoCheck, snapshot };
}

module.exports = { createUpdater, installBlocker, SHARED_STAGING_ID, RELEASES_URL };
