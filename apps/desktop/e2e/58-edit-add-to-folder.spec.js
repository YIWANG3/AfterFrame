// Opened from a folder, what the editor makes joins that folder while the
// "add to <folder>" box is ticked: a saved copy (header box, next to Save),
// split panels (Output section) and an AI repaint (next to Generate). One
// choice, shared with the collage and remembered. Without it, an edit made
// for a folder had to be found in All Assets and dragged back by hand.
//
// The photo lives in a temp dir, not the fixture catalog's folder: split
// panels and repaints are written next to the original.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");

const FOLDER = "Edits home";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-edit-folder-"));
const photoPath = path.join(tmp, "harbour.jpg");

let ctx;
let folderId;
let photoId;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const editorBox = () => ctx.window.getByTestId("editor-add-to-folder");

// By file name: the sidecar stores the resolved path (/private/var/… for a
// macOS temp dir), which is not the string the test handed out.
const folderFiles = () => ctx.window.evaluate((id) => window.mediaWorkspace.browseCollection(id, { limit: 50 })
  .then((rows) => rows.map((r) => r.image_path.split(/[\\/]/).pop())), folderId);

async function openEditorFromFolder() {
  await ctx.window.locator(`[data-asset-id="${photoId}"]`).click();
  await ctx.window.keyboard.press("e");
  await expect(ctx.window.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(ctx.window);
}

async function saveVia(button, fileName) {
  const out = path.join(tmp, fileName);
  await ctx.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, out);
  // The toast comes after the folder step. Earlier toasts linger for 20 s:
  // wait for one more, not for a unique one.
  const toasts = ctx.window.getByText("Saved", { exact: true });
  const before = await toasts.count();
  await button.click();
  await expect(toasts).toHaveCount(before + 1, { timeout: 30_000 });
  // Registered either way; only the folder membership depends on the box.
  expect(await ctx.window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p).then((d) => d?.asset_id || null), out))
    .toBeTruthy();
}

test.beforeAll(async () => {
  await sharp({ create: { width: 2400, height: 800, channels: 3, background: { r: 40, g: 110, b: 170 } } })
    .jpeg({ quality: 90 }).toFile(photoPath);
  ctx = await launchApp({ testName: "edit-add-to-folder" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await ctx.window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  // A mock repaint provider: no network, the job copies the photo.
  await ctx.window.evaluate(async () => {
    await window.mediaWorkspace.saveAiPreferences({
      providers: [{ id: "p_mock", type: "mock", name: "Mock (local)" }],
      activeProvider: "p_mock",
    });
    await window.mediaWorkspace.setAiProviderToken("p_mock", "mock-token");
  });

  await ctx.window.getByTitle("New folder").click();
  const nameInput = ctx.window.getByRole("navigation").locator("input");
  await nameInput.fill(FOLDER);
  await nameInput.press("Enter");
  await expect(ctx.window.getByRole("button", { name: new RegExp(`^${FOLDER}`) })).toBeVisible();
  ({ folderId, photoId } = await ctx.window.evaluate(async ({ name, p }) => {
    const bridge = window.mediaWorkspace;
    const registered = await bridge.quickRegister(p, null);
    const folder = (await bridge.listCollections()).find((c) => c.name === name);
    await bridge.collectionAddItems(folder.collection_id, [registered.asset_id]);
    return { folderId: folder.collection_id, photoId: registered.asset_id };
  }, { name: FOLDER, p: photoPath }));
  await ctx.window.getByRole("button", { name: new RegExp(`^${FOLDER}`) }).click();
  await expect(cards()).toHaveCount(1);
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Save puts the copy in the folder while the box is ticked, and the choice is remembered", async () => {
  await openEditorFromFolder();
  await expect(editorBox()).toBeChecked();
  await expect(editorBox().locator("xpath=..")).toContainText(FOLDER);
  const save = ctx.window.getByRole("button", { name: /^Save$/ });

  await saveVia(save, "harbour_kept.jpg");
  await expect.poll(folderFiles, { timeout: 15_000 }).toContain("harbour_kept.jpg");

  // Unticked: saved and registered, but not in the folder.
  await editorBox().uncheck();
  await saveVia(save, "harbour_loose.jpg");
  expect(await folderFiles()).not.toContain("harbour_loose.jpg");

  // The folder behind the editor shows the kept copy.
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(2);

  // Remembered on the next open; ticked again for the tests below.
  await openEditorFromFolder();
  await expect(editorBox()).not.toBeChecked();
  await editorBox().check();
});

test("split panels join the folder; the panel's box is the same choice", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("split"));
  const box = ctx.window.getByTestId("split-add-to-folder");
  await expect(box).toBeChecked();
  await expect(box.locator("xpath=..")).toContainText(FOLDER);
  // Unticking here unticks the header's box: one choice, two places.
  await box.uncheck();
  await expect(editorBox()).not.toBeChecked();
  await box.check();
  await expect(editorBox()).toBeChecked();

  const outDir = path.join(tmp, "panels");
  fs.mkdirSync(outDir);
  const panels = await ctx.window.evaluate((dir) => window.__afterframeTest.exportSplit(dir, false), outDir);
  expect(panels?.length).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await folderFiles()).filter((f) => f.startsWith("harbour_split_")).length, { timeout: 20_000 })
    .toBe(panels.length);
});

test("an AI repaint joins the folder (the job puts it there)", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("ai"));
  const box = ctx.window.getByTestId("repaint-add-to-folder");
  await expect(box).toBeChecked();
  await ctx.window.getByPlaceholder("Enter a one-time prompt...").fill("make it dusk");
  await ctx.window.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(async () => (await folderFiles()).some((f) => f.startsWith("harbour_ai-repaint_")), { timeout: 30_000 })
    .toBe(true);
});

test("outside a folder the editor offers no box", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.closeEditor());
  await ctx.window.getByRole("button", { name: /All Assets/i }).first().click();
  await ctx.window.locator("[data-gallery-item='true']:not([data-asset-type='video'])").first().click();
  await ctx.window.keyboard.press("e");
  await expect(ctx.window.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 15_000 });
  await expect(editorBox()).toHaveCount(0);
  await ctx.window.evaluate(() => window.__afterframeTest.closeEditor());
});
