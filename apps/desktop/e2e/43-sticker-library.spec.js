// The sticker LIBRARY end to end (coverage report B6). 04-sticker proves
// detection and that cutouts decode; nothing had ever saved one. This spec
// runs the whole loop: detect → outline + name → Save sticker (PNG, 512 px
// thumbnail and library.json under userData/stickers) → star from the
// panel → place it as a layer through the text tool's picker → the
// Stickers view lists it, its inspector toggles the star, and the context
// menu's Delete removes the files. Gated on the Swift/VisionKit toolchain
// like 04 and 07.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");

const isMacOSWithXcode = () =>
  process.platform === "darwin" &&
  fs.existsSync("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift");

let ctx;
let subjectPath;
const libraryDir = () => path.join(ctx.userDataDir, "stickers");
const manifest = () => {
  const file = path.join(libraryDir(), "library.json");
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(data) ? data : data.stickers || data.items || [];
};
const state = () => ctx.window.evaluate(() => window.__afterframeTest.getState());

test.beforeAll(async () => {
  test.skip(!isMacOSWithXcode(), "sticker extraction needs macOS + the Xcode toolchain");
  const sharp = require("sharp");
  subjectPath = path.join(os.tmpdir(), `af-sticker-lib-${Date.now()}.png`);
  await sharp(Buffer.from(
    `<svg width="600" height="600"><rect width="600" height="600" fill="#f4f4f4"/><circle cx="300" cy="300" r="150" fill="#c0392b"/></svg>`,
  )).png().toFile(subjectPath);
  ctx = await launchApp({ testName: "sticker-library" });
  await ctx.window.waitForFunction(() => !!window.__afterframeTest?.openEditor, null, { timeout: 15_000 });
  await ctx.window.evaluate((p) => window.__afterframeTest.openEditor(p), subjectPath);
  await expect(ctx.window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(ctx.window);
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("sticker"));
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (subjectPath) fs.rmSync(subjectPath, { force: true });
});

test("Save sticker writes the PNG, its thumbnail and the manifest; the panel lists it", async () => {
  test.setTimeout(150_000);
  await ctx.window.getByRole("button", { name: /Detect subjects/i }).click();
  await expect(ctx.window.getByText(/Detected \(\d+\)/i)).toBeVisible({ timeout: 90_000 });
  const count = Number((await ctx.window.getByText(/Detected \(\d+\)/i).textContent()).match(/\((\d+)\)/)[1]);
  test.skip(count === 0, "VisionKit found no subject in the synthetic image");

  // Outline width: the SliderRow's number field next to the range input
  // (Playwright cannot fill a range input directly).
  const outline = ctx.window.locator('input[type="range"]').first().locator('xpath=following::input[@type="number"][1]');
  await outline.fill("12");
  await outline.press("Enter");
  await ctx.window.getByPlaceholder("Sticker name").fill("Red disc");
  await ctx.window.getByRole("button", { name: "Save sticker", exact: true }).click();
  await expect(ctx.window.getByText("Sticker saved")).toBeVisible({ timeout: 30_000 });
  await expect(ctx.window.getByText("1 stickers")).toBeVisible();

  const [entry] = manifest();
  expect(entry).toMatchObject({ name: "Red disc", starred: false, outlineWidth: 12 });
  expect(fs.existsSync(path.join(libraryDir(), entry.filename))).toBe(true);
  expect(fs.existsSync(path.join(libraryDir(), entry.thumbFilename))).toBe(true);
  const sharp = require("sharp");
  const thumb = await sharp(path.join(libraryDir(), entry.thumbFilename)).metadata();
  expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(512);
  expect(thumb.hasAlpha).toBe(true);
});

test("the panel's star toggles the manifest flag", async () => {
  const thumb = ctx.window.getByTitle("Red disc", { exact: true }).first();
  await thumb.hover();
  await thumb.getByTitle("Star", { exact: true }).click();
  await expect.poll(() => manifest()[0]?.starred).toBe(true);
  await expect(thumb.getByTitle("Unstar", { exact: true })).toBeVisible();
});

test("the text tool's picker places a library sticker as a layer", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("text"));
  await ctx.window.getByTitle("Add sticker layer", { exact: true }).click();
  await expect(ctx.window.getByText("Pick a sticker")).toBeVisible();
  await ctx.window.getByPlaceholder("Search…").fill("red");
  await ctx.window.getByRole("button", { name: /Red disc/ }).first().click();
  await expect.poll(async () => (await state()).layers.length).toBe(1);
  const [layer] = (await state()).layers;
  expect(layer.type).toBe("sticker");
  expect(layer.stickerPathKind).toBe("path");
  expect(layer.naturalWidth).toBeGreaterThan(0);
  await expect(ctx.window.getByText("Pick a sticker")).toHaveCount(0);
});

test("the Stickers view lists it, its inspector toggles the star, and Delete removes the files", async () => {
  const [entry] = manifest();
  await ctx.window.evaluate(() => window.__afterframeTest.closeEditor?.());
  await ctx.window.getByRole("navigation").getByRole("button", { name: "Stickers" }).click();
  const card = ctx.window.locator(`[data-sticker-card="${entry.id}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(ctx.window.getByRole("heading", { name: "Red disc" })).toBeVisible();
  await ctx.window.getByTitle("Unstar", { exact: true }).click();
  await expect.poll(() => manifest()[0]?.starred).toBe(false);
  await expect(ctx.window.getByTitle("Star", { exact: true })).toBeVisible();

  ctx.window.once("dialog", (dialog) => dialog.accept()); // window.confirm("Delete this sticker?…")
  // A real right-click. This used to be a dispatched MouseEvent because the
  // real one never showed the menu: the opening contextmenu event reached
  // the menu's own outside-click listener while still bubbling and closed it
  // 0.2 ms after it mounted (a user-visible bug; the menu ignores the
  // opening event now).
  await card.click({ button: "right" });
  await ctx.window.getByText("Delete sticker", { exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => manifest().length).toBe(0);
  expect(fs.existsSync(path.join(libraryDir(), entry.filename))).toBe(false);
  await expect(ctx.window.getByText("No stickers yet")).toBeVisible();
});
