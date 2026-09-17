// The collage overlay in SINGLE mode (coverage report B8). 25-collage-batch
// drives batch mode, 32 only hovers the cell menu; the single-page paths —
// the image picker (search, source, add), Replace / Remove from the cell
// menu, template switching and the single export through the native save
// dialog (stubbed in the main process, the same way 25 stubs the folder
// picker) — had never run under e2e.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const imageRows = () => ctx.window.getByTestId("collage-image-list").locator("> *");
const canvas = () => ctx.window.getByTestId("collage-canvas");

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function openSingleCollage() {
  await cards().nth(0).click();
  await cards().nth(1).click({ modifiers: ["Shift"] });
  await cards().nth(0).click({ button: "right" });
  await ctx.window.getByText(/^Collage$/).click();
  await expect(ctx.window.getByRole("button", { name: "Single", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(canvas()).toBeVisible();
}

async function openCellMenu(fx, fy) {
  const box = await canvas().boundingBox();
  await canvas().click({ button: "right", position: { x: box.width * fx, y: box.height * fy } });
  const menu = ctx.window.getByTestId("collage-cell-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "collage-single" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await openSingleCollage();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("single mode opens with the selection and offers the two-image templates", async () => {
  await expect(imageRows()).toHaveCount(2);
  for (const name of ["Left / Right", "Top / Bottom", "Big Left"]) {
    await expect(ctx.window.getByTitle(name, { exact: true })).toBeVisible();
  }
  await ctx.window.getByTitle("Top / Bottom", { exact: true }).click();
  // Stacked layout: the two cells sit above each other, so a right-click at
  // the top and at the bottom of the canvas hit different cells.
  const top = await openCellMenu(0.5, 0.2);
  await expect(top).toContainText("Replace");
  // Close the cell menu with a left click on the canvas — Escape would close
  // the whole overlay ("Close (Esc)"), and any text match could land outside it.
  await canvas().click({ position: { x: 4, y: 4 } });
  await expect(top).toHaveCount(0);
  await expect(ctx.window.getByRole("button", { name: "Single", exact: true })).toBeVisible();
});

test("the picker lists the rest of the catalog, narrows by search and source, and adds one image", async () => {
  await ctx.window.getByRole("button", { name: "Add images", exact: true }).click();
  await expect(ctx.window.getByText(/^Add Images/)).toBeVisible();
  const items = () => ctx.window.locator("[data-picker-item]");
  await expect.poll(async () => items().count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(10);

  const search = ctx.window.getByPlaceholder("Search").last();
  await search.fill("0Y1A");
  await expect.poll(async () => items().count(), { timeout: 10_000 }).toBe(1);
  await search.fill("");

  await ctx.window.getByRole("button", { name: "All", exact: true }).click();
  await ctx.window.getByRole("button", { name: "Rated", exact: true }).click();
  await expect.poll(async () => items().count(), { timeout: 10_000 }).toBeLessThanOrEqual(4);

  const first = ctx.window.locator("[data-picker-item]:not([disabled])").first();
  const picked = await first.getAttribute("data-picker-item");
  await first.click();
  await ctx.window.getByRole("button", { name: /^Add 1$/ }).click();
  await expect(ctx.window.getByText(/^Add Images/)).toHaveCount(0);
  await expect(imageRows()).toHaveCount(3);
  // Three images → the three-cell templates are offered.
  await expect(ctx.window.getByTitle("3 Columns", { exact: true })).toBeVisible();
  expect(picked).toBeTruthy();
});

test("the cell menu replaces one image through the picker; the image list removes another", async () => {
  await ctx.window.getByTitle("3 Columns", { exact: true }).click();
  const before = await ctx.window.getByTestId("collage-image-list").innerText();

  const menu = await openCellMenu(0.17, 0.5);
  await menu.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(ctx.window.getByText(/^Replace Image/)).toBeVisible();
  // The grid positions items absolutely with a transition; take a visible,
  // settled one rather than the first in DOM order.
  const candidate = ctx.window.locator("[data-picker-item]:not([disabled])").filter({ visible: true }).first();
  await expect(candidate).toBeVisible({ timeout: 10_000 });
  // Tiles scale on hover (CSS transition), which Playwright's stability check
  // reads as "still moving" once the pointer arrives; click without it.
  await candidate.click({ force: true });
  await ctx.window.getByRole("button", { name: "Replace", exact: true }).last().click();
  await expect(ctx.window.getByText(/^Replace Image/)).toHaveCount(0);
  await expect(imageRows()).toHaveCount(3);
  await expect.poll(async () => ctx.window.getByTestId("collage-image-list").innerText()).not.toBe(before);

  // Single mode removes through the side panel's image list (the cell menu
  // only offers Remove on batch pages); the row's button shows on hover.
  const lastRow = imageRows().last();
  await lastRow.hover();
  await lastRow.getByTitle("Remove", { exact: true }).click();
  await expect(imageRows()).toHaveCount(2);
  await expect(ctx.window.getByTitle("Left / Right", { exact: true })).toBeVisible();
});

test("Export writes the JPEG at the chosen path and registers it as a version", async () => {
  test.setTimeout(90_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-collage-single-"));
  const out = path.join(dir, "pair_collage.jpg");
  try {
    // register() keeps a reference to the same dialog module object, so this
    // stub reaches workspace:pick-save-path (same trick as 25's folder picker).
    await ctx.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, out);
    await ctx.window.waitForTimeout(500); // let the cell previews settle
    await ctx.window.getByRole("button", { name: "Export", exact: true }).click();
    // The toast fires after saveImage + quickRegister — only then is the file
    // complete (reading earlier caught a half-written JPEG).
    await expect(ctx.window.getByText("Collage exported")).toBeVisible({ timeout: 30_000 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(3000);
    await expect.poll(async () => (await callTool("search_assets", { query: "pair_collage", limit: 5 })).count, { timeout: 15_000 }).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Escape closes the overlay", async () => {
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByRole("button", { name: "Single", exact: true })).toHaveCount(0);
});
