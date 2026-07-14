// Watched directories — a file dropped into a watched folder auto-imports.
// Exercises the full path: chokidar (main) → workspace:watched-import →
// renderer addImagesFromPaths → import job → gallery.

const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
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

  test("overwriting a watched image refreshes its preview without duplicating the asset", async () => {
    const watchedPath = path.join(watchDir, "watched-drop.jpg");
    const canonicalPath = fs.realpathSync(watchedPath);
    const getAsset = () => window.evaluate(async (target) => {
      const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 500 });
      return rows.find((row) => row.image_path === target) || null;
    }, canonicalPath);
    const hashFile = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

    let beforeAsset = null;
    await expect.poll(async () => {
      beforeAsset = await getAsset();
      return beforeAsset?.preview_path && fs.existsSync(beforeAsset.preview_path);
    }, { timeout: 15_000, intervals: [250] }).toBeTruthy();
    const beforePreviewHash = hashFile(beforeAsset.preview_path);

    const replacement = await sharp({
      create: {
        width: 960,
        height: 640,
        channels: 3,
        background: { r: 18, g: 126, b: 214 },
      },
    }).jpeg({ quality: 92 }).toBuffer();
    fs.writeFileSync(watchedPath, replacement); // Lightroom-style overwrite, same path

    let afterAsset = null;
    await expect.poll(async () => {
      afterAsset = await getAsset();
      if (!afterAsset?.preview_path || !fs.existsSync(afterAsset.preview_path)) return null;
      return hashFile(afterAsset.preview_path);
    }, { timeout: 30_000, intervals: [500] }).not.toBe(beforePreviewHash);

    expect(afterAsset.asset_id).toBe(beforeAsset.asset_id);
    const matchingAssets = await window.evaluate(async (target) => {
      const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 500 });
      return rows.filter((row) => row.image_path === target).map((row) => row.asset_id);
    }, canonicalPath);
    expect(matchingAssets).toEqual([beforeAsset.asset_id]);
    const renderedSrc = await window.evaluate((target) => {
      const card = [...document.querySelectorAll("[data-gallery-item='true']")]
        .find((element) => element.dataset.imagePath === target);
      return card?.querySelector("img")?.getAttribute("src") || "";
    }, canonicalPath);
    expect(renderedSrc).toContain("?r=");
  });
});
