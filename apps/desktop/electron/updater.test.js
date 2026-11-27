const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater, installBlocker, SHARED_STAGING_ID } = require("./updater");

// electron-updater's autoUpdater as far as updater.js uses it: each call
// plays back what the real one emits.
function fakeAutoUpdater({ check = "available", version = "0.6.0", download = "ok" } = {}) {
  const emitter = new EventEmitter();
  emitter.app = { baseCachePath: "/cache" };
  emitter.calls = [];
  emitter.checkForUpdates = async () => {
    emitter.calls.push("check");
    emitter.emit("checking-for-update");
    if (check === "available") emitter.emit("update-available", { version });
    else if (check === "current") emitter.emit("update-not-available", { version: "0.5.28" });
    else {
      const error = Object.assign(new Error(`${check}\nstack`), { code: check });
      emitter.emit("error", error);
      throw error;
    }
  };
  emitter.downloadUpdate = async () => {
    emitter.calls.push("download");
    emitter.emit("download-progress", { percent: 41.6 });
    if (download === "ok") emitter.emit("update-downloaded", { version });
    else {
      emitter.emit("error", new Error(download));
      throw new Error(download);
    }
  };
  emitter.quitAndInstall = (...args) => emitter.calls.push(["quitAndInstall", ...args]);
  return emitter;
}

function setup({ autoUpdater = fakeAutoUpdater(), packaged = true, platform = "darwin", env = {}, settings = {}, execPath = "/Applications/AfterFrame.app/Contents/MacOS/AfterFrame", canWrite = () => true } = {}) {
  const handlers = new Map();
  const sent = [];
  const timers = [];
  let saved = settings;
  const updater = createUpdater({
    app: { isPackaged: packaged, getVersion: () => "0.5.28", getPath: () => "/tmp/user-data" },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }] },
    readAppSettings: () => saved,
    updateAppSettings: async (fn) => { saved = fn(saved); return saved; },
    platform,
    env,
    execPath,
    canWrite,
    loadAutoUpdater: () => autoUpdater,
    setTimer: (fn, ms) => { const entry = { fn, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimer: (entry) => { entry.cleared = true; },
    log: { log() {}, warn() {} },
  });
  updater.register();
  return { updater, autoUpdater, handlers, sent, timers, settings: () => saved };
}

test("a check that finds a version waits for a click before downloading", async () => {
  const { updater, autoUpdater, sent } = setup();
  const state = await updater.check();
  assert.equal(state.status, "available");
  assert.equal(state.version, "0.6.0");
  assert.equal(state.releaseUrl, "https://github.com/YIWANG3/AfterFrame/releases/tag/v0.6.0");
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.deepEqual(autoUpdater.calls, ["check"]);
  // Every change went to the window.
  assert.deepEqual(sent.map(([, payload]) => payload.status), ["checking", "available"]);
  assert.ok(sent.every(([channel]) => channel === "app:update-changed"));
});

test("no request carries an id of this install", async () => {
  const { updater, autoUpdater } = setup();
  await updater.check();
  assert.equal(await autoUpdater.stagingUserIdPromise.value, SHARED_STAGING_ID);
});

test("download, then restart installs silently and reopens the app", async () => {
  const { updater, autoUpdater, sent } = setup();
  await updater.check();
  const state = await updater.download();
  assert.equal(state.status, "ready");
  assert.ok(sent.some(([, payload]) => payload.status === "downloading" && payload.percent === 42));
  assert.equal(updater.install(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(autoUpdater.calls.at(-1), ["quitAndInstall", true, true]);
});

test("restart does nothing before a download is ready", async () => {
  const { updater, autoUpdater } = setup();
  assert.equal(updater.install(), false);
  await updater.check();
  assert.equal(updater.install(), false);
  assert.ok(!autoUpdater.calls.some((call) => Array.isArray(call)));
});

test("up to date, and a release without this build's file is up to date too", async () => {
  assert.equal((await setup({ autoUpdater: fakeAutoUpdater({ check: "current" }) }).updater.check()).status, "current");
  const missing = await setup({ autoUpdater: fakeAutoUpdater({ check: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }) }).updater.check();
  assert.equal(missing.status, "current");
  assert.equal(missing.error, null);
});

test("a failed check the user asked for says so; one the app made by itself doesn't", async () => {
  const asked = await setup({ autoUpdater: fakeAutoUpdater({ check: "ERR_NETWORK" }) }).updater.check();
  assert.equal(asked.status, "error");
  assert.deepEqual(asked.error, { stage: "check", message: "ERR_NETWORK" });

  const quiet = await setup({ autoUpdater: fakeAutoUpdater({ check: "ERR_NETWORK" }) }).updater.check({ background: true });
  assert.equal(quiet.status, "idle");
  assert.equal(quiet.error, null);
});

test("a failed download is a download error, and can be tried again", async () => {
  const autoUpdater = fakeAutoUpdater({ download: "sha512 checksum mismatch" });
  const { updater } = setup({ autoUpdater });
  await updater.check();
  const failed = await updater.download();
  assert.deepEqual(failed.error, { stage: "download", message: "sha512 checksum mismatch" });
  await updater.download();
  assert.deepEqual(autoUpdater.calls, ["check", "download", "download"]);
});

test("an error after the download (Squirrel.Mac's signature check) is an install error", async () => {
  const autoUpdater = fakeAutoUpdater();
  const { updater } = setup({ autoUpdater });
  await updater.check();
  await updater.download();
  autoUpdater.emit("error", new Error("Code signature did not match"));
  assert.deepEqual(updater.snapshot().error, { stage: "install", message: "Code signature did not match" });
});

test("a found version says whether the app found it by itself", async () => {
  const { updater } = setup();
  assert.equal((await updater.check({ background: true })).background, true);
  assert.equal((await setup().updater.check()).background, false);
});

test("dev runs and Linux don't update, and never load electron-updater", async () => {
  for (const options of [{ packaged: false }, { platform: "linux" }]) {
    let loaded = false;
    const { updater, timers } = setup({ ...options, autoUpdater: new Proxy({}, { get: () => { loaded = true; } }) });
    updater.start();
    const state = await updater.check();
    assert.equal(state.supported, false);
    assert.equal(state.status, "idle");
    assert.equal(timers.length, 0);
    assert.equal(loaded, false);
  }
});

test("AFTERFRAME_UPDATE_FEED turns a dev run into one that updates from that feed", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-updater-test-"));
  const autoUpdater = fakeAutoUpdater();
  autoUpdater.app = { baseCachePath: path.join(userData, "..", "os-cache") };
  const handlers = new Map();
  const updater = createUpdater({
    app: { isPackaged: false, getVersion: () => "0.5.28", getPath: () => userData },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: { getAllWindows: () => [] },
    readAppSettings: () => ({}),
    updateAppSettings: async () => ({}),
    env: { AFTERFRAME_UPDATE_FEED: "http://127.0.0.1:9/feed/", AFTERFRAME_UPDATE_CHANNEL: "macos12-arm64" },
    loadAutoUpdater: () => autoUpdater,
    log: { log() {}, warn() {} },
  });
  assert.equal((await updater.check()).supported, true);
  assert.equal(autoUpdater.forceDevUpdateConfig, true);
  const config = JSON.parse(fs.readFileSync(autoUpdater.updateConfigPath, "utf8"));
  assert.equal(config.url, "http://127.0.0.1:9/feed/");
  assert.equal(config.channel, "macos12-arm64");
  // The download cache lands in this userData, not the OS cache folder.
  assert.equal(path.join(autoUpdater.app.baseCachePath, config.updaterCacheDirName), path.join(userData, "update-feed", "cache"));
  fs.rmSync(userData, { recursive: true, force: true });
});

test("checks by itself a minute after launch and then daily, unless turned off", async () => {
  const { updater, timers, autoUpdater, settings } = setup({ autoUpdater: fakeAutoUpdater({ check: "current" }) });
  updater.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(autoUpdater.calls, ["check"]);
  assert.equal(timers.at(-1).ms, 24 * 60 * 60 * 1000);

  const off = await updater.setAutoCheck(false);
  assert.equal(off.autoCheck, false);
  assert.deepEqual(settings().updates, { autoCheck: false });
  assert.ok(timers.at(-1).cleared);
  const count = timers.length;
  updater.start();
  assert.equal(timers.length, count);

  assert.equal((await updater.setAutoCheck(true)).autoCheck, true);
  assert.equal(timers.at(-1).ms, 60_000);
});

test("an e2e run of the packaged app doesn't check GitHub by itself", () => {
  const { updater, timers } = setup({ env: { AFTERFRAME_USER_DATA: "/tmp/e2e" } });
  updater.start();
  assert.equal(timers.length, 0);
});

test("an app that can't replace itself still checks, but offers no download", async () => {
  const { updater, autoUpdater } = setup({ execPath: "/Volumes/AfterFrame 0.5.28/AfterFrame.app/Contents/MacOS/AfterFrame", canWrite: () => false });
  const state = await updater.check();
  assert.equal(state.status, "available");
  assert.equal(state.canInstall, false);
  await updater.download();
  assert.deepEqual(autoUpdater.calls, ["check"]);
});

test("installBlocker: a DMG or a translocated copy can't be replaced; /Applications can", () => {
  const writable = new Set(["/Applications", "/Users/me/Applications"]);
  const blocker = (execPath, platform = "darwin") => installBlocker({ platform, execPath, canWrite: (dir) => writable.has(dir) });
  assert.equal(blocker("/Applications/AfterFrame.app/Contents/MacOS/AfterFrame"), null);
  assert.equal(blocker("/Users/me/Applications/AfterFrame.app/Contents/MacOS/AfterFrame"), null);
  assert.equal(blocker("/Volumes/AfterFrame/AfterFrame.app/Contents/MacOS/AfterFrame"), "location");
  assert.equal(blocker("/private/var/folders/x/T/AppTranslocation/1234/d/AfterFrame.app/Contents/MacOS/AfterFrame"), "location");
  assert.equal(blocker("C:\\Users\\me\\AppData\\Local\\Programs\\AfterFrame\\AfterFrame.exe", "win32"), null);
});

test("the IPC handlers answer with the same state", async () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), ["app:update-auto-check", "app:update-check", "app:update-download", "app:update-install", "app:update-state"]);
  assert.equal((await handlers.get("app:update-check")()).status, "available");
  assert.equal((await handlers.get("app:update-state")()).status, "available");
});
