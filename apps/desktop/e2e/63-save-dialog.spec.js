// The editor's Save through the system save panel, as far as an automated test
// can drive it: the panel itself is the OS's, so its answer is given in the
// main process, but everything around it runs for real — what the app asks
// the panel for, what it does with a cancel, and that the format picked in
// the panel (its extension) is the format written, through both the native
// (sharp) and the canvas pipelines, into a folder named like an external
// drive's ("G-DRIVE PRO", Chinese names, spaces).
//
// 06-save drives the same pipelines through the __afterframeTest.saveAs
// backdoor; this is the user's path to them. Still not covered: the panel's
// own UI (picking a format there, browsing to a mounted drive) and a real
// external volume.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");

// libvips keeps the files it read open; Windows can't delete an open file.
sharp.cache(false);

let ctx, outDir, source;
const asked = [];

async function answerSavePanel(answer) {
  await ctx.app.evaluate(({ dialog }, reply) => {
    globalThis.__savePanelCalls ??= [];
    dialog.showSaveDialog = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === "object" && "filters" in arg) || args.at(-1);
      globalThis.__savePanelCalls.push(options);
      return reply;
    };
  }, answer);
}

async function saveThroughPanel(answer) {
  await answerSavePanel(answer);
  const toasts = ctx.window.getByText("Saved", { exact: true });
  const before = await toasts.count();
  await ctx.window.getByRole("button", { name: /^Save$/ }).click();
  // The panel is asked for over IPC, a moment after the click.
  await expect.poll(() => ctx.app.evaluate(() => globalThis.__savePanelCalls.length)).toBe(1);
  asked.push(...(await ctx.app.evaluate(() => globalThis.__savePanelCalls.splice(0))));
  return { toasts, before };
}

// A save is done when its file is in the catalog. Counting "Saved" toasts
// raced on a slow PC: the earlier ones expire while this one is written.
async function expectRegistered(file) {
  await expect.poll(() => ctx.window.evaluate(
    (p) => window.mediaWorkspace.getAssetDetail(p).then((d) => d?.image_path ?? null, () => null), file,
  ), { timeout: 30_000 }).toBe(file);
}

test.beforeAll(async () => {
  outDir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-panel-"))), "G-DRIVE PRO", "外接盘 测试");
  fs.mkdirSync(outDir, { recursive: true });
  ctx = await launchApp({ testName: "save-panel" });
  const card = ctx.window.locator("[data-gallery-item='true'][data-image-path$='0Y1A6707-9.jpg']");
  await expect(card).toBeVisible({ timeout: 15_000 });
  source = await card.getAttribute("data-image-path");
  await card.click();
  await ctx.window.keyboard.press("e");
  await expect(ctx.window.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(ctx.window, { preview: true });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (outDir) fs.rmSync(path.dirname(path.dirname(outDir)), { recursive: true, force: true });
});

test("the panel is offered JPEG, PNG and WebP, starting from <name>_edited.jpg next to the original", async () => {
  await saveThroughPanel({ canceled: true, filePath: "" });
  const [options] = asked;
  expect(options.filters.map((filter) => filter.name)).toEqual(["JPEG", "PNG", "WebP"]);
  expect(options.filters.flatMap((filter) => filter.extensions)).toEqual(["jpg", "jpeg", "png", "webp"]);
  expect(options.defaultPath).toBe(path.join(path.dirname(source), "0Y1A6707-9_edited.jpg"));
});

test("Cancel in the panel writes nothing and registers nothing", async () => {
  const count = () => ctx.window.evaluate(() => window.mediaWorkspace.getSummary().then((s) => s.browse_assets));
  const before = await count();
  const { toasts, before: toastsBefore } = await saveThroughPanel({ canceled: true, filePath: "" });
  await ctx.window.waitForTimeout(1_000);
  expect(await toasts.count()).toBe(toastsBefore);
  expect(fs.readdirSync(outDir)).toEqual([]);
  expect(await count()).toBe(before);
  expect(await ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen())).toBe(true);
});

for (const [name, format] of [["CUA 导出.png", "png"], ["CUA 导出.webp", "webp"], ["CUA 导出.jpg", "jpeg"]]) {
  test(`picking ${format.toUpperCase()} in the panel writes ${format.toUpperCase()} at full size, and it is registered`, async () => {
    const out = path.join(outDir, name);
    await saveThroughPanel({ canceled: false, filePath: out });
    await expectRegistered(out);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(format);
    // Untouched: the original's own size (the native pipeline).
    const original = await sharp(source).metadata();
    expect([meta.width, meta.height]).toEqual([original.width, original.height]);
  });
}

test("with a text layer (the canvas pipeline) the picked format is still the one written", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("text"));
  await ctx.window.evaluate(() => window.__afterframeTest.addTextLayer("外接盘"));
  const out = path.join(outDir, "CUA 文字.png");
  await saveThroughPanel({ canceled: false, filePath: out });
  await expectRegistered(out);
  expect((await sharp(out).metadata()).format).toBe("png");
});
