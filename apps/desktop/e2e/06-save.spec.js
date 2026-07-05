// Save-pipeline tests — the most important regression check.
// Verifies the editor's full Save flow lands a real JPEG on disk for
// three distinct paths:
//   1. native-sharp fast-path (no overlay layers, source intact)
//   2. canvas fallback with a text layer (uses drawLayers.js)
//   3. canvas fallback with stickerless rotate/crop (still native fast path)

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");

async function openEditorOnFirstAsset(window) {
  // Wait for gallery, single-click to select, press E to open editor (the
  // app's keyboard shortcut). Double-click would open the lightbox instead.
  await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
  await window.locator("[data-gallery-item='true']").first().click();
  await window.keyboard.press("e");
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
}

async function saveTo(window, savePath) {
  return await window.evaluate(async (p) => {
    await window.__afterframeTest.saveAs(p);
  }, savePath);
}

test.describe("Save pipeline", () => {
  let app, window, userDataDir;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-save-out-"));

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "save" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("select card + press E opens the editor", async () => {
    await openEditorOnFirstAsset(window);
  });

  test("native sharp save: editor with no overlay layers writes a JPG", async () => {
    const out = path.join(tmpDir, "native-save.jpg");
    await saveTo(window, out);
    expect(fs.existsSync(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test("canvas fallback save: add a text layer then save", async () => {
    // Switch to Text tool + add a layer (addTextLayer returns post-add count)
    await window.waitForFunction(() => typeof window.__afterframeTest?.setTool === "function", null, { timeout: 10_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
    const result = await window.evaluate(() => window.__afterframeTest.addTextLayer("Hello E2E"));
    expect(result.id).toBeTruthy();
    expect(result.count).toBeGreaterThan(0);

    // Save — this exercises drawLayers.js (canvas path)
    const out = path.join(tmpDir, "text-layer-save.jpg");
    await saveTo(window, out);
    expect(fs.existsSync(out)).toBe(true);
    const stat = fs.statSync(out);
    expect(stat.size).toBeGreaterThan(1000); // non-trivial output
  });

  // Every saved edit must be linked back to the original as a version in the
  // same resource set (stack), AND the original must reference the new image —
  // both directions. Guards the editor save → quick-register → catalog chain.
  test("saved edit joins the original's version stack (original ↔ new reference)", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor?.());

    // The original (first cataloged asset) + its resource set, before editing.
    const originId = await window.locator("[data-gallery-item='true']").first().getAttribute("data-asset-id");
    expect(originId).toBeTruthy();
    const originBefore = await window.evaluate((id) => window.mediaWorkspace.getAssetDetailById(id), originId);
    expect(originBefore?.resource_set_id).toBeTruthy();

    await openEditorOnFirstAsset(window);
    await window.waitForFunction(() => typeof window.__afterframeTest?.saveAs === "function", null, { timeout: 10_000 });
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady?.()), { timeout: 10_000 })
      .toBe(true);
    const out = path.join(tmpDir, "linked-edit.jpg");
    await saveTo(window, out);
    expect(fs.existsSync(out)).toBe(true);
    const outReal = fs.realpathSync(out);

    // The new file was registered into the catalog (quick-register ran).
    let newDetail;
    await expect
      .poll(async () => {
        newDetail = await window.evaluate(
          (paths) => window.mediaWorkspace.getAssetDetail(paths[0]).then((d) => d || window.mediaWorkspace.getAssetDetail(paths[1])),
          [outReal, out],
        );
        return newDetail?.asset_id || null;
      }, { timeout: 10_000 })
      .toBeTruthy();

    // NEW → ORIGINAL: same resource set + lists the original as a sibling.
    expect(newDetail.resource_set_id).toBe(originBefore.resource_set_id);
    expect((newDetail.version_siblings || []).map((s) => s.asset_id)).toContain(originId);

    // ORIGINAL → NEW: the original's version stack now includes the new image.
    const originAfter = await window.evaluate((id) => window.mediaWorkspace.getAssetDetailById(id), originId);
    expect((originAfter.version_siblings || []).map((s) => s.asset_id)).toContain(newDetail.asset_id);
  });

  test("rotate save: 90° turn writes swapped dimensions", async () => {
    // Fresh editor session so the text layer from the previous test doesn't
    // force the canvas path — rotate/crop alone stays on the native one.
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    await openEditorOnFirstAsset(window);

    const before = await sharp(path.join(tmpDir, "native-save.jpg")).metadata();

    await window.waitForFunction(() => typeof window.__afterframeTest?.setTool === "function", null, { timeout: 10_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("crop"));
    // Rotating before the preview finishes decoding is silently ignored
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady()), { timeout: 10_000 })
      .toBe(true);
    await window.getByRole("button", { name: /90° L/ }).click();
    // commitTransform is React state — give it a beat before saving
    await window.waitForTimeout(500);
    const out = path.join(tmpDir, "rotated-save.jpg");
    await saveTo(window, out);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(before.height);
    expect(meta.height).toBe(before.width);
  });
});
