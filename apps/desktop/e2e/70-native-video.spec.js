// Optional real ProRes regression. Set AFTERFRAME_TEST_PRORES to a local clip;
// it is imported into a private catalog, never converted or copied into git.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, closeApp, importThroughToolbar, byImagePath } = require("./helpers/app");

const original = process.env.AFTERFRAME_TEST_PRORES;
const SAMPLE_VIDEO = "z-sample-video.mp4"; // the seeded catalog's own clip
test("ProRes plays at original resolution without a proxy; controls and native view lifecycle work", async () => {
  test.skip(process.platform !== "darwin" || !original, "requires a local ProRes clip on macOS");
  test.setTimeout(90_000);
  const ctx = await launchApp({ testName: "native-prores" });
  const w = ctx.window;
  try {
    await expect(w.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
    // The seeded photos, by the file name the lightbox's filmstrip shows.
    const photos = await w.locator("[data-gallery-item='true'][data-asset-type='image']")
      .evaluateAll((cards) => cards.map((card) => card.dataset.imagePath.split(/[\\/]/).pop()));
    const strip = (names) => w.locator(`button[data-on="false"]:is(${names.map((name) => `[title="${name}"]`).join(",")})`).first();
    await importThroughToolbar(ctx.app, w, [original]);
    const card = w.locator(`[data-gallery-item='true']${byImagePath(original)}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const start = Date.now();
    await card.dblclick();
    const surface = w.locator('[data-video-engine="avplayer"]');
    await expect(surface).toHaveAttribute("data-video-ready", "true", { timeout: 15_000 });
    const token = await surface.getAttribute("data-video-session");
    const state = () => w.evaluate((session) => window.mediaWorkspace.nativeVideoState(session), token);
    const first = await state();
    console.log(JSON.stringify({ nativeFirstFrameMs: Date.now() - start, ...first }));
    expect(first.width).toBe(3840); expect(first.height).toBe(2160);
    expect(first.failed).toBe(false);
    expect(fs.existsSync(path.join(ctx.userDataDir, "video-proxies"))).toBe(false);
    await expect(w.locator("video")).toHaveCount(0);
    const transport = surface.locator("xpath=ancestor::div[contains(@class,'flex-col')][1]");
    await transport.getByRole("button").first().click();
    await expect.poll(async () => (await state()).playing).toBe(false);
    // The button shows what was asked for, not a state read already on its way.
    await expect(transport.getByRole("button").first().locator("svg")).toHaveClass(/lucide-play/);
    const held = (await state()).time;
    await w.waitForTimeout(300);
    expect((await state()).time).toBeCloseTo(held, 2);
    const seekTime = Math.min(4, first.duration / 2);
    await w.getByLabel("Seek").fill(String(seekTime));
    await expect.poll(async () => {
      const s = await state(); return !s.seeking && Math.abs(s.time - seekTime) < 0.05;
    }).toBe(true);
    await transport.getByRole("button").nth(1).click();
    await expect.poll(async () => (await state()).muted).toBe(true);
    // Native picture must not cover Settings, which lives in the DOM above it.
    await w.keyboard.press("Meta+,");
    await expect(w.locator("[data-top-layer]")).toBeVisible();
    await expect.poll(async () => (await state()).visible).toBe(false);
    await w.keyboard.press("Escape");
    await expect.poll(async () => (await state()).visible).toBe(true);
    // Nor the confirm that Delete opens over the lightbox.
    await w.keyboard.press("Backspace");
    await expect(w.locator("[data-top-layer]")).toBeVisible();
    await expect.poll(async () => (await state()).visible).toBe(false);
    await w.keyboard.press("Escape");
    await expect(w.locator("[data-top-layer]")).toHaveCount(0);
    await expect.poll(async () => (await state()).visible).toBe(true);
    // The picture follows the page's surface (points = CSS px x zoom).
    const placed = async () => {
      const [{ frame }, box, zoom] = await Promise.all([
        state(), surface.boundingBox(),
        ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),
      ]);
      return ["x", "y", "width", "height"].every((key) => Math.abs(frame[key] - box[key] * zoom) < 1);
    };
    await expect.poll(placed).toBe(true);
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
    await expect(surface).toHaveAttribute("data-video-ready", "true");
    await expect.poll(placed).toBe(true);
    await transport.getByRole("button").last().click();
    const fullscreen = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isSimpleFullScreen());
    await expect.poll(fullscreen).toBe(true);
    await expect(w.locator("html")).toHaveClass(/\bfs\b/);
    await expect.poll(placed).toBe(true);
    await transport.getByRole("button").last().click();
    await expect.poll(fullscreen).toBe(false);
    await transport.getByRole("button").first().click();
    await expect.poll(async () => (await state()).time).toBeGreaterThan(seekTime + 0.1);
    // Switching to a photo disposes the native layer and its sound. The
    // filmstrip, so where the clip sorts doesn't matter.
    await strip(photos).click();
    await expect(surface).toHaveCount(0);
    await expect.poll(state).toBe(null);
    await w.keyboard.press("Escape");
    await card.dblclick();
    await expect(w.locator('[data-video-engine="avplayer"]')).toHaveAttribute("data-video-ready", "true");
    const reopened = await w.locator('[data-video-engine="avplayer"]').getAttribute("data-video-session");
    expect(reopened).not.toBe(token);
    await w.locator('[data-video-engine="avplayer"]').locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").getByRole("button").last().click();
    await expect.poll(fullscreen).toBe(true);
    // Stepping to the next clip keeps the screen; only leaving the lightbox
    // puts the window back.
    await strip([SAMPLE_VIDEO]).click();
    await expect.poll(() => w.evaluate((session) => window.mediaWorkspace.nativeVideoState(session), reopened)).toBe(null);
    await expect(w.locator('[data-video-engine="avplayer"]')).toHaveAttribute("data-video-ready", "true");
    expect(await fullscreen()).toBe(true);
    const sample = await w.locator('[data-video-engine="avplayer"]').getAttribute("data-video-session");
    await w.keyboard.press("Escape");
    await expect.poll(() => w.evaluate((session) => window.mediaWorkspace.nativeVideoState(session), sample)).toBe(null);
    await expect.poll(fullscreen).toBe(false);
    expect(fs.existsSync(path.join(ctx.userDataDir, "video-proxies"))).toBe(false);
  } finally { await closeApp(ctx.app, ctx.userDataDir); }
});
