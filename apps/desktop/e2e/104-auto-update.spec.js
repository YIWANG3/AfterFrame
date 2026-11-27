// In-app updates (electron/updater.js, docs/auto-update.md): the app checks a
// feed, says what it found in a toast and in Settings ▸ About, downloads the
// new version with its checksum verified, and hands it to the installer on
// Restart to Update.
//
// The feed is a server in this process standing in for the GitHub release
// (AFTERFRAME_UPDATE_FEED); everything between the app and that feed is the
// real electron-updater. The one stand-in is Squirrel.Mac, the macOS piece
// that swaps the .app: it needs a signed app and would replace the Electron
// this spec runs. The stub does what it does up to the swap: fetch the
// download from electron-updater's local proxy, then report it ready.

const { test, expect } = require("@playwright/test");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, closeApp } = require("./helpers/app");

const CURRENT = require("../package.json").version;
const NEXT = "99.0.0";
// No "arm64" in the name: electron-updater would drop it on an Intel Mac.
const ZIP_NAME = `AfterFrame-${NEXT}-mac.zip`;
const ZIP = crypto.randomBytes(3 * 1024 * 1024);
const SHA512 = crypto.createHash("sha512").update(ZIP).digest("base64");

let ctx;
let server;
let feedUrl;
// What the feed answers: "available" (NEXT), "current" (this version) or "fail" (HTTP 500).
let mode = "available";
const requests = [];

function updateInfo(version) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${ZIP_NAME}`,
    `    sha512: ${SHA512}`,
    `    size: ${ZIP.length}`,
    `path: ${ZIP_NAME}`,
    `sha512: ${SHA512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
}

function startFeed() {
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://feed");
    requests.push({ pathname, headers: req.headers });
    if (pathname.endsWith(".yml")) {
      if (mode === "fail") { res.writeHead(500); res.end("feed down"); return; }
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end(updateInfo(mode === "current" ? CURRENT : NEXT));
      return;
    }
    if (pathname === `/${ZIP_NAME}`) {
      // About 3 s, so the download is on screen long enough to see.
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP.length });
      let offset = 0;
      const step = 64 * 1024;
      const send = () => {
        if (offset >= ZIP.length) { res.end(); return; }
        res.write(ZIP.subarray(offset, offset + step));
        offset += step;
        setTimeout(send, 60);
      };
      send();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    feedUrl = `http://127.0.0.1:${server.address().port}/`;
    resolve();
  }));
}

const settingsNav = () => ctx.window.getByRole("navigation", { name: "Settings" });
const updateRow = () => ctx.window.locator("[data-update-status]");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await startFeed();
  ctx = await launchApp({
    testName: "auto-update",
    env: { AFTERFRAME_UPDATE_FEED: feedUrl, AFTERFRAME_UPDATE_CHECK_DELAY_MS: "1000" },
  });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  server?.close();
});

test("a new version the app finds by itself is said once, and leads to Settings ▸ About", async () => {
  const w = ctx.window;
  // Nothing asked: the check a moment after launch found it.
  await expect(w.getByText(`AfterFrame ${NEXT} is available`, { exact: true })).toBeVisible({ timeout: 20_000 });
  await w.getByRole("button", { name: "Details", exact: true }).click();

  await expect(updateRow()).toHaveAttribute("data-update-status", "available");
  await expect(updateRow()).toContainText(`AfterFrame ${NEXT} is available.`);
  await expect(updateRow().getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect(w.locator("[data-app-version]")).toHaveText(new RegExp(`^${CURRENT.replace(/\./g, "\\.")} · (arm64|x64)$`));
  // About carries a dot while the version waits.
  await expect(settingsNav().getByRole("button", { name: "About" }).locator("[data-update-dot]")).toBeVisible();

  // The check said nothing about which install made it.
  const check = requests.find((r) => r.pathname.endsWith(".yml"));
  expect(check.headers["x-user-staging-id"]).toBe("00000000-0000-0000-0000-000000000000");
  // Each build reads its own channel's file (here the default one).
  expect(check.pathname).toBe(process.platform === "win32" ? "/latest.yml" : process.platform === "darwin" ? "/latest-mac.yml" : "/latest-linux.yml");
});

test("Check for Updates… in the menu checks again; a failed check says so and can be retried", async () => {
  const w = ctx.window;
  await w.keyboard.press("Escape");
  await expect(settingsNav()).toHaveCount(0);

  mode = "fail";
  await ctx.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("check-updates").click());
  await expect(settingsNav()).toBeVisible();
  await expect(updateRow()).toHaveAttribute("data-update-status", "error", { timeout: 15_000 });
  await expect(updateRow()).toContainText("Couldn't check for updates.");

  mode = "current";
  await updateRow().getByRole("button", { name: "Try Again", exact: true }).click();
  await expect(updateRow()).toHaveAttribute("data-update-status", "current", { timeout: 15_000 });
  await expect(updateRow()).toContainText("AfterFrame is up to date.");
  await expect(settingsNav().locator("[data-update-dot]")).toHaveCount(0);
});

test("Check automatically is a setting the app keeps", async () => {
  const w = ctx.window;
  const toggle = w.locator("[data-settings-overlay]").getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const settingsFile = path.join(ctx.userDataDir, "afterframe", "settings.json");
  await expect.poll(() => JSON.parse(fs.readFileSync(settingsFile, "utf8")).updates).toEqual({ autoCheck: false });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("Download fetches the version and checks it; Restart to Update hands it to the installer", async () => {
  test.skip(process.platform !== "darwin", "Windows installs on quit: a real download here would run on the app's close");
  const w = ctx.window;
  // Squirrel.Mac up to the swap: it takes the download from
  // electron-updater's proxy, says it is ready, and records the install.
  await ctx.app.evaluate(({ autoUpdater }) => {
    const squirrel = { bytes: 0, installs: 0 };
    globalThis.__squirrel = squirrel;
    autoUpdater.setFeedURL = (options) => { squirrel.feed = options; };
    autoUpdater.checkForUpdates = async () => {
      const { url, headers } = squirrel.feed;
      const { url: zipUrl } = await (await fetch(url, { headers })).json();
      squirrel.bytes = (await (await fetch(zipUrl)).arrayBuffer()).byteLength;
      autoUpdater.emit("update-downloaded");
    };
    autoUpdater.quitAndInstall = () => { squirrel.installs += 1; };
  });

  mode = "available";
  await updateRow().getByRole("button", { name: "Check Now", exact: true }).click();
  await expect(updateRow()).toHaveAttribute("data-update-status", "available", { timeout: 15_000 });
  await updateRow().getByRole("button", { name: "Download", exact: true }).click();
  await expect(updateRow().getByRole("progressbar")).toBeVisible();
  await expect(updateRow()).toHaveAttribute("data-update-status", "ready", { timeout: 30_000 });
  await expect(updateRow()).toContainText(`${NEXT} is downloaded. It installs when you quit.`);

  // The download is the one the feed named, kept in this run's own folder.
  const cached = path.join(ctx.userDataDir, "update-feed", "cache", "pending", ZIP_NAME);
  expect(crypto.createHash("sha512").update(fs.readFileSync(cached)).digest("base64")).toBe(SHA512);
  await expect.poll(() => ctx.app.evaluate(() => globalThis.__squirrel.bytes)).toBe(ZIP.length);

  await updateRow().getByRole("button", { name: "Restart to Update", exact: true }).click();
  await expect.poll(() => ctx.app.evaluate(() => globalThis.__squirrel.installs)).toBe(1);
});
