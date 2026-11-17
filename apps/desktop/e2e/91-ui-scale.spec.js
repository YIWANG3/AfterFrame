// Settings ▸ General ▸ Interface scale zooms the whole window as one (the
// page zoom electron/uiScale.js sets), saves the choice, and a relaunch
// opens at it again. ⌘- / ⌘= / ⌘0 (Ctrl elsewhere, the View menu's
// accelerators) step it the same way, and the open Settings row follows.

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

// The View menu carries the keys as accelerators, so they fire on macOS and
// on Windows (where the title strip's button shows the same menu). Synthetic
// key presses reach the page, not the native menu, so this reads each item's
// accelerator and clicks it the way the accelerator would.
const menuItem = (id) => ctx.app.evaluate(({ Menu }, itemId) => {
  const item = Menu.getApplicationMenu().getMenuItemById(itemId);
  return item ? { accelerator: item.accelerator, label: item.label } : null;
}, id);
const clickMenu = (id) => ctx.app.evaluate(({ Menu, BrowserWindow }, itemId) => {
  Menu.getApplicationMenu().getMenuItemById(itemId).click(undefined, BrowserWindow.getAllWindows()[0]);
}, id);

test("View ▸ Zoom In / Zoom Out / Actual Size sit on ⌘= / ⌘- / ⌘0 (Ctrl elsewhere) and step the scale; the Settings row follows", async () => {
  expect(await menuItem("view-zoom-in")).toEqual({ accelerator: "CmdOrCtrl+=", label: "Zoom In" });
  expect(await menuItem("view-zoom-out")).toEqual({ accelerator: "CmdOrCtrl+-", label: "Zoom Out" });
  expect(await menuItem("view-zoom-reset")).toEqual({ accelerator: "CmdOrCtrl+0", label: "Actual Size" });

  await expect(scaleSelect()).toHaveValue("1");
  await clickMenu("view-zoom-out");
  await expect.poll(zoomFactor).toBe(0.9);
  await expect(scaleSelect()).toHaveValue("0.9");
  await clickMenu("view-zoom-out");
  await expect.poll(zoomFactor).toBe(0.8);
  await clickMenu("view-zoom-out");
  await expect.poll(zoomFactor).toBe(0.8); // the smallest stays put
  await clickMenu("view-zoom-in");
  await expect.poll(zoomFactor).toBe(0.9);
  await clickMenu("view-zoom-reset");
  await expect.poll(zoomFactor).toBe(1);
  await expect(scaleSelect()).toHaveValue("1");
  await expect.poll(savedScale).toBe(1);
});

// The number pad is caught in the main process (before-input-event), which
// Playwright's page-level key presses skip; sendInputEvent goes that way.
const numpad = (keyCode) => ctx.app.evaluate(({ BrowserWindow }, key) => {
  const modifiers = [process.platform === "darwin" ? "meta" : "control"];
  const contents = BrowserWindow.getAllWindows()[0].webContents;
  contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
  contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
}, keyCode);

test("the number pad's - / 0 with ⌘ (Ctrl) work too", async () => {
  await numpad("numsub");
  await expect.poll(zoomFactor).toBe(0.9);
  await numpad("num0");
  await expect.poll(zoomFactor).toBe(1);
});
