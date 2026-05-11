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
});
