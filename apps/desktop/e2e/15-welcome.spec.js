// First-run / no-catalog state. Packaged installs open no catalog by default;
// the app must guide the user to create/open one instead of silently failing.
// Simulated via AFTERFRAME_NO_DEFAULT_CATALOG (see helpers/app.js noCatalog).

const path = require("node:path");
const fs = require("node:fs");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");
const sampleManifest = require("../sample-photos/manifest.json");
const sampleNames = Object.keys(sampleManifest).sort();

async function expectSampleOriginals(window, userDataDir) {
  await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus()), {
    timeout: 30_000,
  }).toMatchObject({ status: "succeeded" });
  const rows = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }));
  expect(rows).toHaveLength(14);
  expect(rows.map((row) => path.basename(row.image_path)).sort()).toEqual(sampleNames);
  for (const row of rows) {
    expect(row.image_path).toBe(fs.realpathSync(path.join(userDataDir, "afterframe", "sample.afcatalog", "photos", path.basename(row.image_path))));
    expect(row.image_metadata).toMatchObject(sampleManifest[path.basename(row.image_path)]);
  }
  await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getSummary())).toMatchObject({ image_assets: 14 });
}

test.describe("First run (no catalog)", () => {
  let app, window, userDataDir;
  const mainLogs = [];

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "welcome", noCatalog: true }));
    app.process().stdout.on("data", (data) => mainLogs.push(String(data)));
    app.process().stderr.on("data", (data) => mainLogs.push(String(data)));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("electron-main.log", { body: mainLogs.join(""), contentType: "text/plain" });
    }
  });

  test("shows the welcome guide with create/open/sample actions", async () => {
    await expect(window.getByText("Welcome to AfterFrame")).toBeVisible({ timeout: 10_000 });
    await expect(window.getByRole("button", { name: "New Catalog" })).toBeVisible();
    await expect(window.getByRole("button", { name: /Open Existing/ })).toBeVisible();
    await expect(window.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
  });

  test("settings shortcut remains available before opening a catalog", async () => {
    await window.keyboard.press("Meta+,");
    await expect(window.getByRole("button", { name: "General", exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
  });

  test("no gallery cards render without a catalog", async () => {
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(0);
  });

  // Runs last: it leaves the app inside the sample catalog.
  test("sample library: one click creates it, opens it, and shows the banner", async () => {
    await window.getByRole("button", { name: "Browse Sample Library" }).click();
    // Switching in shows the persistent sample banner with its two exits.
    await expect(window.getByText(/browsing the sample library/i)).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("button", { name: "Create My Library" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Reset Sample Library" })).toBeVisible();
    // The bundled photos import in the background and land in the gallery.
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 120_000 });
    await expectSampleOriginals(window, userDataDir);
  });

  test("sample library: reset wipes and rebuilds it in place", async () => {
    // Start another import and reset without waiting for it to finish. This
    // used to race ongoing writes and fail ENOTEMPTY.
    // A sentinel proves the old directory was wiped without relying on
    // filesystem birthtime precision or accepting stale pre-reset gallery cards.
    const dbPath = path.join(userDataDir, "afterframe", "sample.afcatalog", "catalog.sqlite3");
    const sentinel = path.join(path.dirname(dbPath), "reset-sentinel");
    fs.mkdirSync(sentinel);
    await window.evaluate((photosDir) => window.mediaWorkspace.startImport({
      mode: "processed_only", imageDirs: [photosDir],
    }), path.join(path.dirname(dbPath), "photos"));
    const previousJob = await window.evaluate(() => window.mediaWorkspace.getImportStatus());
    const logStart = mainLogs.length;

    await window.getByRole("button", { name: "Reset Sample Library" }).click();
    await window.getByRole("button", { name: "Reset", exact: true }).click();

    await expect
      .poll(() => !fs.existsSync(sentinel) && fs.existsSync(dbPath), { timeout: 30_000 })
      .toBe(true);
    await expect(window.getByRole("button", { name: "Reset Sample Library" })).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus()), {
      timeout: 30_000,
    }).toMatchObject({ status: "succeeded" });
    const rebuiltJob = await window.evaluate(() => window.mediaWorkspace.getImportStatus());
    expect(rebuiltJob.jobId).not.toBe(previousJob.jobId);
    // Still inside the sample catalog; the demo photos re-import.
    await expect(window.getByText(/browsing the sample library/i)).toBeVisible({ timeout: 30_000 });
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 120_000 });
    expect(mainLogs.slice(logStart).join("")).not.toContain("Error occurred in handler for 'workspace:reset-sample-catalog'");
    await expectSampleOriginals(window, userDataDir);
  });

  test("legacy sample previews are removed on app restart without losing original ratings", async () => {
    const catalogPath = path.join(userDataDir, "afterframe", "sample.afcatalog");
    const photosDir = path.join(catalogPath, "photos");
    // Recreate the old shipping layout, including all 14 web-demo thumbnails.
    fs.cpSync(path.join(__dirname, "..", "sample-photos", "previews"), path.join(photosDir, "previews"), { recursive: true });
    await window.evaluate((dir) => window.mediaWorkspace.startImport({ mode: "processed_only", imageDirs: [dir] }), photosDir);
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus()), { timeout: 30_000 })
      .toMatchObject({ status: "succeeded" });
    const before = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }));
    expect(before).toHaveLength(28);
    const original = before.find((row) => row.image_path === fs.realpathSync(path.join(photosDir, "sample-01.jpg")));
    await window.evaluate((id) => window.mediaWorkspace.setAssetRating([id], 5), original.asset_id);

    await app.close();
    ({ app, window } = await launchApp({ withCatalog: false, reuseUserDataDir: userDataDir }));
    app.process().stdout.on("data", (data) => mainLogs.push(String(data)));
    app.process().stderr.on("data", (data) => mainLogs.push(String(data)));
    await expectSampleOriginals(window, userDataDir);
    const after = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }));
    expect(after.find((row) => row.asset_id === original.asset_id)?.app_rating).toBe(5);
    expect(fs.readdirSync(path.join(catalogPath, "legacy-sample-previews")).sort()).toEqual(sampleNames);
    expect(fs.readdirSync(path.join(photosDir, "previews"))).toHaveLength(0);
    // Reopening again is idempotent: no reset or duplicate re-import.
    await window.evaluate((dir) => window.mediaWorkspace.switchCatalog(dir), catalogPath);
    await expectSampleOriginals(window, userDataDir);
  });
});
