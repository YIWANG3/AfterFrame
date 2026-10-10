// Remembered choices (docs/settings-scope.md, src/utils/prefs.js): a tool
// opens on what it was last set to, after a restart too. The first run sets
// the text look, the collage canvas, the split ratio, the gallery's layout
// and a Settings tab; the second run, on the same userData, finds them.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, waitForEditor } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

test.describe.configure({ mode: "serial" });

let ctx;
let fixturePath;
let firstByName;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const editorState = () => ctx.window.evaluate(() => window.__afterframeTest.getState());
const splitAspect = async () => (await ctx.window.evaluate(() => window.__afterframeTest.getSplitState()))?.aspectKey;
const addTextButton = () => ctx.window.getByTitle("Add text layer", { exact: true });
const canvasSlider = (label) => ctx.window.getByText(label, { exact: true }).locator("xpath=../..").locator("input[type=range]");
const settingsTabs = () => ctx.window.getByRole("navigation", { name: "Settings" });

async function openEditorOn(tool) {
  await ctx.window.waitForFunction(() => !!window.__afterframeTest?.openEditor, null, { timeout: 10_000 });
  await ctx.window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
  await waitForEditor(ctx.window, { preview: true });
  await ctx.window.evaluate((t) => window.__afterframeTest.setTool(t), tool);
}

async function closeEditor() {
  await ctx.window.evaluate(() => window.__afterframeTest.closeEditor());
  await expect(cards().first()).toBeVisible();
}

// Adds a text layer with the panel's "+" and returns it as stored.
async function addTextWithButton() {
  const before = (await editorState()).layers.length;
  await addTextButton().click();
  await expect.poll(async () => (await editorState()).layers.length).toBe(before + 1);
  return (await editorState()).layers.at(-1);
}

async function openCollage() {
  await cards().nth(0).click();
  await cards().nth(1).click({ modifiers: ["Shift"] });
  await cards().nth(0).click({ button: "right" });
  await ctx.window.getByText(/^Collage$/).click();
  await expect(ctx.window.getByTestId("collage-canvas")).toBeVisible({ timeout: 10_000 });
}

async function closeCollage() {
  await ctx.window.getByTitle("Close (Esc)", { exact: true }).click();
  await expect(ctx.window.getByTestId("collage-canvas")).toHaveCount(0);
}

async function restart() {
  await collectCoverage(ctx.app); // the restart bypasses closeApp
  await ctx.app.close();
  Object.assign(ctx, await launchApp({ testName: "remembered-choices", reuseUserDataDir: ctx.userDataDir, keepCatalog: true }));
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  fixturePath = await ensureFixture();
  ctx = await launchApp({ testName: "remembered-choices" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("the next text starts with the look of the last one styled", async () => {
  await openEditorOn("text");
  const first = await addTextWithButton();
  expect(first.fontFamily).toBe("Plus Jakarta Sans");
  expect(first.shadow).toBe(false);

  // A preset on the selected text, then another font: both are the look.
  await ctx.window.getByRole("button", { name: /Noir$/ }).click();
  await ctx.window.getByTestId("font-select").click();
  const search = ctx.window.getByPlaceholder("Search fonts…");
  await search.fill("Space Mono");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect.poll(async () => (await editorState()).layers.find((l) => l.id === first.id).fontFamily).toBe("Space Mono");

  const second = await addTextWithButton();
  expect(second.text).toBe("New Text");
  expect(second.fontFamily).toBe("Space Mono");
  expect(second.italic).toBe(true);
  expect(second.shadow).toBe(true);
  expect(second.fillColor).toBe("#efe8da");
  expect(second.fontSize).toBeCloseTo(130, 0);
  // Its position is a new layer's, not the styled one's.
  expect([second.x, second.y]).toEqual([0.5, 0.5]);
  await closeEditor();
});

test("the collage keeps its canvas and export width", async () => {
  await openCollage();
  await ctx.window.getByRole("button", { name: "3:4", exact: true }).click();
  await canvasSlider("Gap").fill("24");
  await ctx.window.getByTitle("#1e3a2f", { exact: true }).click();
  await ctx.window.getByRole("button", { name: "2048px", exact: true }).click();
  await expect(ctx.window.getByTestId("collage-canvas-reset")).toBeVisible();
  await closeCollage();
});

test("the split keeps its panel ratio, the gallery its layout, Settings its tab", async () => {
  await openEditorOn("split");
  await expect.poll(splitAspect).toBe("3:4");
  await ctx.window.getByRole("button", { name: "1:1" }).click();
  await expect.poll(splitAspect).toBe("1:1");
  await closeEditor();

  await ctx.window.getByTitle("Layout", { exact: true }).click();
  await ctx.window.getByRole("button", { name: "Waterfall", exact: true }).click();
  await ctx.window.getByLabel("Thumbnail size").fill("240");
  const firstByImport = await cards().first().getAttribute("data-image-path");
  await ctx.window.getByRole("button", { name: "Imported ↓", exact: true }).click();
  await ctx.window.getByRole("button", { name: "Name A-Z", exact: true }).click();
  await expect(ctx.window.getByRole("button", { name: "Name A-Z", exact: true })).toBeVisible();
  await expect.poll(() => cards().first().getAttribute("data-image-path")).not.toBe(firstByImport);
  firstByName = await cards().first().getAttribute("data-image-path");

  await ctx.window.keyboard.press("Meta+,");
  await settingsTabs().getByRole("button", { name: "About" }).click();
  await expect(ctx.window.getByText(/local-first photo workspace/i)).toBeVisible();
  await ctx.window.keyboard.press("Escape");
  await expect(settingsTabs()).toHaveCount(0);
});

test("after a restart, everything comes back", async () => {
  await restart();

  await expect(ctx.window.getByLabel("Thumbnail size")).toHaveValue("240");
  await expect(ctx.window.getByRole("button", { name: "Name A-Z", exact: true })).toBeVisible();
  await expect(cards().first()).toHaveAttribute("data-image-path", firstByName);
  await ctx.window.getByTitle("Layout", { exact: true }).click();
  await expect(ctx.window.getByRole("button", { name: "Waterfall", exact: true })).toHaveClass(/text-text/);
  await ctx.window.keyboard.press("Escape");

  await ctx.window.keyboard.press("Meta+,");
  await expect(ctx.window.getByText(/local-first photo workspace/i)).toBeVisible();
  await ctx.window.keyboard.press("Escape");
  await expect(settingsTabs()).toHaveCount(0);

  await openEditorOn("text");
  const text = await addTextWithButton();
  expect(text.fontFamily).toBe("Space Mono");
  expect(text.italic).toBe(true);
  expect(text.fillColor).toBe("#efe8da");
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("split"));
  await expect.poll(splitAspect).toBe("1:1");
  await closeEditor();

  await openCollage();
  await expect(canvasSlider("Gap")).toHaveValue("24");
  await expect(ctx.window.getByRole("button", { name: "2048px", exact: true })).toHaveClass(/bg-selected/);
  await expect(ctx.window.getByRole("button", { name: "3:4", exact: true })).toHaveClass(/bg-selected/);
  // "Defaults" puts the canvas back and is gone until something changes.
  await ctx.window.getByTestId("collage-canvas-reset").click();
  await expect(canvasSlider("Gap")).toHaveValue("0");
  await expect(ctx.window.getByRole("button", { name: "1:1", exact: true })).toHaveClass(/bg-selected/);
  await expect(ctx.window.getByTestId("collage-canvas-reset")).toHaveCount(0);
  // The export width is not part of the canvas.
  await expect(ctx.window.getByRole("button", { name: "2048px", exact: true })).toHaveClass(/bg-selected/);
  await closeCollage();
});
