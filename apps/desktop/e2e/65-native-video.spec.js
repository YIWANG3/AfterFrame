// Optional real ProRes regression. Set AFTERFRAME_TEST_PRORES to a local clip;
// it is imported into a private catalog, never converted or copied into git.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, closeApp, importThroughToolbar, byImagePath } = require("./helpers/app");

const original = process.env.AFTERFRAME_TEST_PRORES;
test("ProRes plays at original resolution without a proxy; controls and native view lifecycle work", async () => {
  test.skip(process.platform !== "darwin" || !original, "requires a local ProRes clip on macOS");
  test.setTimeout(90_000);
  const ctx = await launchApp({ testName: "native-prores" });
  const w = ctx.window;
  try {
    await expect(w.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
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
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
    await expect(surface).toHaveAttribute("data-video-ready", "true");
    await transport.getByRole("button").last().click();
    const fullscreen = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isSimpleFullScreen());
    await expect.poll(fullscreen).toBe(true);
    await expect(w.locator("html")).toHaveClass(/\bfs\b/);
    await transport.getByRole("button").last().click();
    await expect.poll(fullscreen).toBe(false);
    await transport.getByRole("button").first().click();
    await expect.poll(async () => (await state()).time).toBeGreaterThan(seekTime + 0.1);
    // Switching to a photo disposes the native layer and its sound.
    await w.keyboard.press("ArrowRight");
    await expect(surface).toHaveCount(0);
    await expect.poll(state).toBe(null);
    await w.keyboard.press("Escape");
    await card.dblclick();
    await expect(w.locator('[data-video-engine="avplayer"]')).toHaveAttribute("data-video-ready", "true");
    const reopened = await w.locator('[data-video-engine="avplayer"]').getAttribute("data-video-session");
    expect(reopened).not.toBe(token);
    await w.locator('[data-video-engine="avplayer"]').locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").getByRole("button").last().click();
    await expect.poll(fullscreen).toBe(true);
    await w.keyboard.press("Escape");
    await expect.poll(() => w.evaluate((session) => window.mediaWorkspace.nativeVideoState(session), reopened)).toBe(null);
    await expect.poll(fullscreen).toBe(false);
    expect(fs.existsSync(path.join(ctx.userDataDir, "video-proxies"))).toBe(false);
  } finally { await closeApp(ctx.app, ctx.userDataDir); }
});
