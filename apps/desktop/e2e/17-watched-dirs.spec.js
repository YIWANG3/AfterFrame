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
  let app, window, userDataDir, watchDir;

  test.beforeAll(async () => {
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-watch-"));
    ({ app, window, userDataDir } = await launchApp({ testName: "watched" }));
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
