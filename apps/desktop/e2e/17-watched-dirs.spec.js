// Watched directories — a file dropped into a watched folder auto-imports.
// Exercises the full path: chokidar (main) → workspace:watched-import →
// renderer addImagesFromPaths → import job → gallery.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp } = require("./helpers/app");

const SRC_IMAGE = path.resolve(__dirname, "fixtures", "test-image.jpg");

test.describe("Watched directories", () => {
  let app, window, userDataDir, catalogDir, watchDir;

  test.beforeAll(async () => {
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-watch-"));
    ({ app, window, userDataDir, catalogDir } = await launchApp({ testName: "watched" }));
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    try { fs.rmSync(watchDir, { recursive: true, force: true }); } catch {}
  });

  test("add/remove watched dir round-trips through settings", async () => {
    const after = await window.evaluate((d) => window.mediaWorkspace.addWatchedDir(d), watchDir);
    expect(after).toContain(watchDir);
    const list = await window.evaluate(() => window.mediaWorkspace.getWatchedDirs());
    expect(list).toContain(watchDir);
    const catalogSettings = JSON.parse(fs.readFileSync(path.join(catalogDir, "settings.json"), "utf8"));
    expect(catalogSettings.integrations.watchedDirs).toContain(watchDir);
  });

  test("watch list and queued events stay with their catalog", async () => {
    const otherCatalog = path.join(userDataDir, "portraits.afcatalog");
    fs.mkdirSync(otherCatalog, { recursive: true });
    await window.evaluate(() => {
      window.__watchedImportCount = 0;
      window.__stopWatchedProbe = window.mediaWorkspace.onWatchedImport(() => {
        window.__watchedImportCount += 1;
      });
    });

    await window.evaluate((catalogPath) => window.mediaWorkspace.switchCatalog(catalogPath), otherCatalog);
    expect(await window.evaluate(() => window.mediaWorkspace.getWatchedDirs())).toEqual([]);

    // An event from the old catalog must not leak through after the switch.
    fs.copyFileSync(SRC_IMAGE, path.join(watchDir, "old-catalog-only.jpg"));
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await window.evaluate(() => window.__watchedImportCount)).toBe(0);

    await window.evaluate((catalogPath) => window.mediaWorkspace.switchCatalog(catalogPath), catalogDir);
    expect(await window.evaluate(() => window.mediaWorkspace.getWatchedDirs())).toContain(watchDir);
    await window.evaluate(() => window.__stopWatchedProbe?.());
  });

  test("a new file in the watched dir auto-imports into the gallery", async () => {
    const before = await window.locator("[data-gallery-item='true']").count();
    // Drop a (catalog-new) image into the watched folder.
    fs.copyFileSync(SRC_IMAGE, path.join(watchDir, "watched-drop.jpg"));
    // chokidar awaitWriteFinish (~1.5s) + debounce (1s) + import job — be patient.
    await expect
      .poll(() => window.locator("[data-gallery-item='true']").count(), { timeout: 25_000, intervals: [500] })
      .toBeGreaterThan(before);
  });
});
