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
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

let ctx;
const cards = () => galleryCards(ctx.window);
const imageRows = () => ctx.window.getByTestId("collage-image-list").locator("> *");
const canvas = () => ctx.window.getByTestId("collage-canvas");
// The toast fires after saveImage + quickRegister, naming the file. Earlier
// exports' toasts last 20 s and can expire mid-wait, so counting them races.
const exportedToast = (file) => ctx.window.getByTestId("toast-card").filter({ hasText: "Collage exported" }).filter({ hasText: file });

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);

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
    const height = await scroller.evaluate((element) => {
      const css = getComputedStyle(element);
      const paddingX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
      const paddingY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
      const rows = Math.ceil(element.querySelectorAll("[data-picker-item]").length / 4);
      const tileSize = (element.getBoundingClientRect().width - paddingX - 3 * 4) / 4;
      element.style.flex = "none";
      element.style.height = `${rows * tileSize + (rows - 1) * 4 + paddingY - 3}px`;
      return parseFloat(element.style.height);
    });
    // The new height is laid out and the grid has had a frame to react to it
    // (its ResizeObserver, then the render) before the samples start.
    await expect.poll(() => scroller.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(height, 0);
    await ctx.window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
  // Back at two photos the collage restores the layout last picked for two,
  // Top / Bottom from the first test, where (0.75, 0.5) is the line between the
  // cells: an odd canvas height put the click in the top one.
  await expect(imageRows()).toHaveCount(2);
  await ctx.window.getByTitle("Left / Right", { exact: true }).click();
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

// Mean colour of a patch of the single canvas, in display px.
const meanColor = (x, y, w, h) => canvas().evaluate((c, [px, py, pw, ph]) => {
  const dpr = window.devicePixelRatio || 1;
  const { data } = c.getContext("2d").getImageData(Math.round(px * dpr), Math.round(py * dpr), Math.max(1, Math.round(pw * dpr)), Math.max(1, Math.round(ph * dpr)));
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += data[i + k];
  return sum.map((v) => Math.round(v / (data.length / 4)));
}, [x, y, w, h]);

// The slider is the quick drag; the number field beside it takes an exact
// value, applied as it is typed and clamped to the remembered range on blur.
test("gap, padding and corner radius take a typed value", async () => {
  const field = (label) => ctx.window.getByText(label, { exact: true }).locator("xpath=../..");
  const gapInput = ctx.window.getByTestId("collage-gap-input");
  const gapSlider = field("Gap").locator('input[type="range"]');
  await gapInput.fill("37");
  await expect(gapSlider).toHaveValue("37");
  // Beyond the slider's range is fine up to the cap; past the cap it clamps when the field is left.
  await gapInput.fill("9999");
  await gapInput.press("Enter");
  await expect(gapInput).toHaveValue("2000");
  await expect(gapSlider).toHaveValue(String(await gapSlider.getAttribute("max")));
  await gapInput.fill("0");
  await expect(gapSlider).toHaveValue("0");

  const radiusInput = ctx.window.getByTestId("collage-radius-input");
  await radiusInput.fill("120");
  await expect(field("Border Radius").locator('input[type="range"]')).toHaveValue("120");
  await radiusInput.fill("0");
  await ctx.window.getByTestId("collage-padding-input").fill("8");
  await expect(field("Padding").locator('input[type="range"]')).toHaveValue("8");
  await ctx.window.getByTestId("collage-padding-input").fill("0");
  await expect(ctx.window.getByTestId("collage-canvas-reset")).toHaveCount(0);
});

// Edge blend cross-fades neighbouring photos across a band centred on their
// shared edge, a linear ramp: the two cells meet halfway at the seam and
// three quarters of the way in, a quarter. The page's outer edge, which no
// other cell meets, stays as it is. The colour fixtures are gentle
// gradients and the blend cover-fits each one to its wider reach, so the
// references are read after the blend, just outside the band on each side.
test("edge blend cross-fades neighbouring cells across a linear band", async () => {
  // Two solid-colour fixtures join the pair: cells 3 and 4, the bottom row
  // of the 2×2 grid, purple on the left and pink on the right.
  for (const name of ["007-purple", "008-pink"]) {
    await ctx.window.getByRole("button", { name: "Add images", exact: true }).click();
    const search = ctx.window.getByPlaceholder("Search").last();
    await search.fill(name);
    const items = ctx.window.locator("[data-picker-item]:not([disabled])");
    await expect.poll(() => items.count(), { timeout: 10_000 }).toBe(1);
    await items.first().click({ force: true });
    await ctx.window.getByRole("button", { name: /^Add 1$/ }).click();
    await expect(ctx.window.getByText(/^Add Images/)).toHaveCount(0);
  }
  await expect(imageRows()).toHaveCount(4);
  await ctx.window.getByTitle("2x2 Grid", { exact: true }).click();
  const size = await canvas().boundingBox();
  const seam = size.width / 2;
  const y = size.height * 0.75;
  const at = (x) => meanColor(x, y - 10, 2, 20);
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const purple = await at(seam - 120);
  const pink = await at(seam + 120);
  expect(near(purple, pink, 30)).toBe(false);
  const brightness = ([r, g, b]) => (r + g + b) / 3;
  const edgeBefore = brightness(await meanColor(4, y - 10, 2, 20));
  const seamBefore = await at(seam - 1);

  const input = ctx.window.getByTestId("collage-edge-blend-input");
  await input.fill("400");
  await expect(ctx.window.getByText("Edge Blend", { exact: true }).locator("xpath=../..").locator('input[type="range"]')).toHaveValue("400");
  await expect(ctx.window.getByTestId("collage-canvas-reset")).toBeVisible();
  // 400 export px on a 4096 export: the band is a tenth of the canvas wide.
  const half = size.width * (400 / 4096) / 2;
  await expect.poll(async () => {
    const left = await at(seam - half - 6);
    const right = await at(seam + half + 6);
    const mix = (k) => left.map((v, i) => Math.round(v * (1 - k) + right[i] * k));
    const samples = [
      [await at(seam - 1), mix(0.5)],
      [await at(seam - half / 2), mix(0.25)],
      [await at(seam + half / 2), mix(0.75)],
      // The band's ends: where a mask on a fractional rect once left a bright line.
      [await at(seam - half), left],
      [await at(seam + half), right],
    ];
    return samples.map(([got, want]) => (near(got, want, 14) ? "ok" : `${got} vs ${want}`)).join("; ");
  }).toBe("ok; ok; ok; ok; ok");
  // Nothing fades at the page's edge: no cell meets it.
  expect(brightness(await meanColor(4, y - 10, 2, 20))).toBeGreaterThan(edgeBefore * 0.8);

  await input.fill("0");
  await expect.poll(async () => near(await at(seam - 1), seamBefore, 6)).toBe(true);
  await expect(ctx.window.getByTestId("collage-canvas-reset")).toHaveCount(0);
  // Back to the pair, Left / Right, for the tests below.
  for (let i = 0; i < 2; i++) {
    const lastRow = imageRows().last();
    await lastRow.hover();
    await lastRow.getByTitle("Remove", { exact: true }).click();
  }
  await expect(imageRows()).toHaveCount(2);
  await ctx.window.getByTitle("Left / Right", { exact: true }).click();
});

// A photo zoomed out or panned no longer fills its cell, and the export shows
// background there. The box marks those areas and counts the cells.
test("Highlight uncovered areas marks the cell its photo no longer fills", async () => {
  const box = ctx.window.getByTestId("collage-show-gaps");
  const count = ctx.window.getByTestId("collage-gap-count");
  await expect(box).not.toBeChecked();
  await expect(count).toHaveCount(0);
  await box.check();
  await expect(count).toHaveText("Every cell is covered");

  // Left / Right: select the left cell and zoom it out to 0.8.
  const size = await canvas().boundingBox();
  await canvas().click({ position: { x: size.width * 0.25, y: size.height * 0.5 } });
  const zoom = ctx.window.locator('input[type="range"][min="0.5"][max="5"]');
  await expect(zoom).toBeVisible();
  const band = [size.width * 0.1, 2, size.width * 0.3, 6]; // the top of the left cell
  const before = await meanColor(...band);
  await zoom.fill("0.8");
  await expect(count).toHaveText("1 cell not fully covered");
  // A landscape photo zoomed out leaves bands at the top and bottom: the top
  // band is now a warning red, which the photo was not.
  await expect.poll(async () => {
    const [r, g, b] = await meanColor(...band);
    return r > 120 && r - Math.max(g, b) > 40;
  }).toBe(true);
  expect(await meanColor(...band)).not.toEqual(before);

  // Off: the canvas shows the photo as it is, the count goes.
  await box.uncheck();
  await expect(count).toHaveCount(0);
  await expect.poll(async () => {
    const [r, g, b] = await meanColor(...band);
    return r - Math.max(g, b) > 40;
  }).toBe(false);

  // Back to a full cell for the exports below: on again, it says so.
  await ctx.window.getByRole("button", { name: "Reset", exact: true }).click();
  await box.check();
  await expect(count).toHaveText("Every cell is covered");
  await box.uncheck();
  await ctx.window.getByTitle("Deselect (Esc)").click();
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
    // The export waits for the HD previews it draws from itself
    // (CollageOverlay.waitForHdPreviews, CollageCanvas.exportToBlob).
    await expect(ctx.window.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
    await ctx.window.getByRole("button", { name: "Export", exact: true }).click();
    // The toast fires after saveImage + quickRegister — only then is the file
    // complete (reading earlier caught a half-written JPEG).
    await expect(ctx.window.getByText("Collage exported")).toBeVisible({ timeout: 30_000 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(4096); // the default export width
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
    await expect(ctx.window.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
    await ctx.window.getByRole("button", { name: "Export", exact: true }).click();
    await expect(exportedToast(out)).toBeVisible({ timeout: 30_000 });

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect((await sharp(out).metadata()).format).toBe("png");
    expect([info.width, info.height, info.channels]).toEqual([4096, 4096, 3]);
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
    await expect(ctx.window.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
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
