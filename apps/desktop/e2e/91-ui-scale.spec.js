// Settings ▸ General ▸ Interface scale zooms the whole window as one (the
// page zoom electron/uiScale.js sets), saves the choice, and a relaunch
// opens at it again.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, closeApp, collectCoverage, galleryCards } = require("./helpers/app");

let ctx;
const zoomFactor = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
const savedScale = () => JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, "afterframe", "settings.json"), "utf-8")).uiScale;
const scaleSelect = () => ctx.window.getByTestId("ui-scale");

async function openGeneralSettings() {
  await ctx.window.keyboard.press("ControlOrMeta+,");
  await expect(ctx.window.getByText("Appearance")).toBeVisible({ timeout: 5_000 });
  await expect(scaleSelect()).toBeVisible();
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "ui-scale" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("starts at 100%, and choosing 90% zooms the whole window out and saves it", async () => {
  await openGeneralSettings();
  await expect(scaleSelect()).toHaveValue("1");
  expect(await zoomFactor()).toBe(1);
  const before = await ctx.window.evaluate(() => window.innerWidth);

  await scaleSelect().selectOption("0.9");
  await expect.poll(zoomFactor).toBe(0.9);
  // Zoomed out, the same window lays out more CSS pixels: everything is smaller.
  await expect.poll(() => ctx.window.evaluate(() => window.innerWidth)).toBeGreaterThan(before);
  await expect.poll(savedScale).toBe(0.9);
});

test("a relaunch opens at the saved scale", async () => {
  await collectCoverage(ctx.app); // the restart path bypasses closeApp
  await ctx.app.close();
  ctx = { ...ctx, ...(await launchApp({ testName: "ui-scale", reuseUserDataDir: ctx.userDataDir, keepCatalog: true })) };
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(zoomFactor).toBe(0.9);

  await openGeneralSettings();
  await expect(scaleSelect()).toHaveValue("0.9");
  await scaleSelect().selectOption("1");
  await expect.poll(zoomFactor).toBe(1);
  await expect.poll(savedScale).toBe(1);
});
