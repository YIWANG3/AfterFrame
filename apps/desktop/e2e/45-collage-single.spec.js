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
// The toast fires after saveImage + quickRegister, naming the file. Earlier
// exports' toasts last 20 s and can expire mid-wait, so counting them races.
const exportedToast = (file) => ctx.window.getByTestId("toast-card").filter({ hasText: "Collage exported" }).filter({ hasText: file });

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

for (const pickerMode of ["add", "replace"]) {
  test(`${pickerMode} picker stays stable at the scrollbar threshold and still scrolls`, async () => {
    if (pickerMode === "add") {
      await ctx.window.getByRole("button", { name: "Add images", exact: true }).click();
    } else {
      const menu = await openCellMenu(0.5, 0.2);
      await menu.getByRole("button", { name: "Replace", exact: true }).click();
    }
    const scroller = ctx.window.getByTestId("collage-picker-scroll");
    const items = scroller.locator("[data-picker-item]");
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(10);

    // Choose a height between the grid's heights with and without a classic
    // scrollbar. Previously each ResizeObserver update toggled the scrollbar,
    // resizing every tile again on the next frame.
    await scroller.evaluate((element) => {
      const css = getComputedStyle(element);
      const paddingX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
      const paddingY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
      const rows = Math.ceil(element.querySelectorAll("[data-picker-item]").length / 4);
      const tileSize = (element.getBoundingClientRect().width - paddingX - 3 * 4) / 4;
      element.style.flex = "none";
      element.style.height = `${rows * tileSize + (rows - 1) * 4 + paddingY - 3}px`;
    });
    await ctx.window.waitForTimeout(250);
    const widths = await scroller.evaluate(async (element) => {
      const samples = [];
      for (let frame = 0; frame < 60; frame++) {
        await new Promise(requestAnimationFrame);
        samples.push(element.querySelector("[data-picker-item]").getBoundingClientRect().width);
      }
      return [...new Set(samples)];
    });
    expect(widths).toHaveLength(1);

    await scroller.evaluate((element) => { element.style.height = "200px"; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(items.last()).toBeInViewport();
    expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Close only the picker, leaving the collage and its selection intact.
    await scroller.locator("..").locator("button").first().click();
    await expect(scroller).toHaveCount(0);
  });
}

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

  // The side panel's image list removes too; the row's button shows on hover.
  const lastRow = imageRows().last();
  await lastRow.hover();
  await lastRow.getByTitle("Remove", { exact: true }).click();
  await expect(imageRows()).toHaveCount(2);
  await expect(ctx.window.getByTitle("Left / Right", { exact: true })).toBeVisible();
});

test("the cell menu removes the photo under the pointer, no matching it to a list row", async () => {
  // Two photos, Left / Right: right-click the right cell, and the left one stays.
  await expect(imageRows()).toHaveCount(2);
  const keep = await imageRows().first().innerText();
  const menu = await openCellMenu(0.75, 0.5);
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(imageRows()).toHaveCount(1);
  expect(await imageRows().first().innerText()).toBe(keep);
  await expect(ctx.window.getByTestId("collage-cell-menu")).toHaveCount(0);
  // Back to a pair for the export below.
  await ctx.window.getByRole("button", { name: "Add images", exact: true }).click();
  const candidate = ctx.window.locator("[data-picker-item]:not([disabled])").filter({ visible: true }).first();
  await expect(candidate).toBeVisible({ timeout: 10_000 });
  await candidate.click({ force: true });
  await ctx.window.getByRole("button", { name: /^Add 1$/ }).click();
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

// The PNG choice in the save dialog used to write a lossless copy of a 0.92
// JPEG. The render is lossless now: the padding band around the photos is
// exactly the background colour, with none of the ringing a JPEG puts next
// to an edge, and an opaque render carries no alpha channel.
test("Export as PNG is a lossless render", async () => {
  test.setTimeout(90_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-collage-png-"));
  const out = path.join(dir, "pair_collage.png");
  const padding = ctx.window.getByText("Padding", { exact: true }).locator("xpath=../..").locator('input[type="range"]');
  const PAD = 40;
  try {
    await padding.fill(String(PAD));
    await ctx.window.getByTitle("#3b1a1a", { exact: true }).click();
    await ctx.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, out);
    await ctx.window.waitForTimeout(500);
    await ctx.window.getByRole("button", { name: "Export", exact: true }).click();
    await expect(exportedToast(out)).toBeVisible({ timeout: 30_000 });

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect((await sharp(out).metadata()).format).toBe("png");
    expect([info.width, info.height, info.channels]).toEqual([3000, 3000, 3]);
    const off = [];
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (x >= PAD && x < info.width - PAD && y >= PAD && y < info.height - PAD) continue;
        const i = (y * info.width + x) * 3;
        if (data[i] !== 0x3b || data[i + 1] !== 0x1a || data[i + 2] !== 0x1a) off.push([x, y, data[i], data[i + 1], data[i + 2]]);
      }
    }
    expect(off.slice(0, 5), `${off.length} padding pixels are not #3b1a1a`).toEqual([]);
  } finally {
    await padding.fill("0");
    await ctx.window.getByTitle("#000000", { exact: true }).click();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Escape closes the overlay", async () => {
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByRole("button", { name: "Single", exact: true })).toHaveCount(0);
});

// Opened from inside a folder, the overlay offers to put the export there; the
// choice is remembered. Without it, a collage made for a folder had to be
// found in All Assets and dragged back by hand.
test("a collage made inside a folder joins that folder while the box is ticked", async () => {
  test.setTimeout(90_000);
  await ctx.window.getByTitle("New folder").click();
  const nameInput = ctx.window.getByRole("navigation").locator("input");
  await nameInput.fill("Collage home");
  await nameInput.press("Enter");
  await expect(ctx.window.getByRole("button", { name: /^Collage home/ })).toBeVisible();
  const folderId = await ctx.window.evaluate(async () => {
    const bridge = window.mediaWorkspace;
    const rows = (await bridge.browseImages({ status: "all", limit: 50 })).filter((r) => r.asset_type !== "video");
    const folder = (await bridge.listCollections()).find((c) => c.name === "Collage home");
    await bridge.collectionAddItems(folder.collection_id, rows.slice(0, 2).map((r) => r.asset_id));
    return folder.collection_id;
  });
  // By file name: the sidecar stores the resolved path (/private/var/… for a
  // macOS temp dir), which is not the string the dialog stub handed out.
  const folderFiles = () => ctx.window.evaluate((id) => window.mediaWorkspace.browseCollection(id, { limit: 50 })
    .then((rows) => rows.map((r) => r.image_path.split(/[\\/]/).pop())), folderId);
  await ctx.window.getByRole("button", { name: /^Collage home/ }).click();
  await expect(cards()).toHaveCount(2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-collage-folder-"));
  const exportTo = async (name) => {
    const out = path.join(dir, name);
    await ctx.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, out);
    await ctx.window.waitForTimeout(500);
    await ctx.window.getByRole("button", { name: "Export", exact: true }).click();
    await expect(exportedToast(out)).toBeVisible({ timeout: 30_000 });
    return out;
  };
  try {
    await openSingleCollage();
    const box = ctx.window.getByTestId("collage-add-to-folder");
    await expect(box).toBeChecked();
    await exportTo("home_collage.jpg");
    await expect.poll(folderFiles, { timeout: 15_000 }).toContain("home_collage.jpg");
    // The folder behind the overlay shows it too.
    await ctx.window.keyboard.press("Escape");
    await expect(cards()).toHaveCount(3);

    // Unticked: the export is registered but stays out of the folder, and the
    // choice is remembered the next time the overlay opens.
    await openSingleCollage();
    await box.uncheck();
    await exportTo("loose_collage.jpg");
    await expect.poll(async () => (await callTool("search_assets", { query: "loose_collage", limit: 5 })).count, { timeout: 15_000 }).toBe(1);
    expect(await folderFiles()).not.toContain("loose_collage.jpg");
    await ctx.window.keyboard.press("Escape");
    await expect(cards()).toHaveCount(3);
    await openSingleCollage();
    await expect(box).not.toBeChecked();
    await box.check();
    await ctx.window.keyboard.press("Escape");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
