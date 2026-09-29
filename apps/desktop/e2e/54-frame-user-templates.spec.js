// User frame templates and the watermark profile (docs/next-features-plan.md
// §E): a look made in the editor on one photo is saved as a template, survives
// a restart, and lands on a photo of another camera and another shape with its
// text resolved for THAT photo, through the editor and through apply_frame.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, collectCoverage, waitForEditor, mcpCall } = require("./helpers/app");

let app, window, userDataDir, mcpPort;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-user-frame-"));
const AUTHOR = "Yi Test";
const LANDSCAPE = "0Y1A6707-9"; // Canon EOS R6m2, 2400×1600
const PORTRAIT = "B0016108"; // CFV 100C/907X, 2064×2400

const rowFor = (stem) => window.evaluate(
  (s) => window.mediaWorkspace.browseImages({ status: "all", limit: 100, sort: "name-asc" }).then((rows) => rows.find((r) => r.stem === s)),
  stem,
);
const editorState = () => window.evaluate(() => window.__afterframeTest.getState());
const templates = () => window.evaluate(() => window.mediaWorkspace.listFrameTemplates());

async function openEditorOn(stem) {
  const row = await rowFor(stem);
  await window.evaluate((item) => window.__afterframeTest.openEditor(item), row);
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(window, { preview: true });
  await window.evaluate(() => window.__afterframeTest.setTool("text"));
  return row;
}
async function closeEditor() {
  await window.evaluate(() => window.__afterframeTest.closeEditor());
  await expect(window.getByRole("button", { name: /^Save$/i })).toHaveCount(0);
}

test.beforeAll(async () => {
  ({ app, window, userDataDir, mcpPort } = await launchApp({ testName: "frame-user-templates" }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (app) await closeApp(app, userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the author set in Settings is what Insert photo info › Author writes", async () => {
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
  const field = window.locator("[data-watermark-author]");
  await field.fill(AUTHOR);
  await field.press("Enter");
  await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getWatermarkProfile())).toEqual({ author: AUTHOR });
  await window.keyboard.press("Escape");

  await openEditorOn(LANDSCAPE);
  await window.getByTitle("Insert photo info").click();
  await window.locator("[data-token='author']").click();
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain(AUTHOR);
});

test("a preset plus your own text saves as a template that keeps where each part came from", async () => {
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain("Canon EOS R6m2");

  await window.locator("[data-save-frame-template]").click();
  const name = window.locator("[data-frame-template-name] input");
  await name.fill("My bar");
  await name.press("Enter");
  await expect.poll(async () => (await templates()).length).toBe(1);
  const [saved] = await templates();
  expect(saved.id).toMatch(/^user:/);
  expect(saved.name).toBe("My bar");
  expect(saved.canvas.pad.bottom).toBeGreaterThan(0.05);
  // The model line is still {camera_model}, the author still {author}; no logo pixels.
  const texts = saved.layers.filter((l) => l.type === "text");
  expect(texts.map((l) => l.tokenSource?.content)).toEqual(expect.arrayContaining(["{camera_model}", "{author}"]));
  expect(JSON.stringify(saved)).not.toContain("data:");
  // It is first in the panel, named.
  await expect(window.locator(`[data-frame-template="${saved.id}"]`).first()).toContainText("My bar");
  await closeEditor();
});

test("after a restart the template is still there, and renaming keeps its id", async () => {
  const [before] = await templates();
  await collectCoverage(app); // the restart path bypasses closeApp
  await app.close();
  ({ app, window, mcpPort } = await launchApp({ testName: "frame-user-templates", reuseUserDataDir: userDataDir, keepCatalog: true }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  expect((await templates()).map((t) => t.id)).toEqual([before.id]);

  await openEditorOn(PORTRAIT);
  const cell = window.locator(`[data-frame-template="${before.id}"]`).first();
  await cell.hover();
  await cell.getByTitle("Rename").click();
  const name = window.locator("[data-frame-template-name] input");
  await name.fill("Bar, renamed");
  await name.press("Enter");
  await expect.poll(async () => (await templates()).map((t) => [t.id, t.name])).toEqual([[before.id, "Bar, renamed"]]);
});

test("on a portrait photo from another camera the template is re-resolved and saved at full size", async () => {
  const [tpl] = await templates();
  await window.evaluate((id) => window.__afterframeTest.applyFramePreset(id), tpl.id);
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain("CFV 100C/907X");
  const state = await editorState();
  expect(state.layers.map((l) => l.text)).toContain(AUTHOR);
  expect(state.layers.map((l) => l.text)).not.toContain("Canon EOS R6m2");
  expect(state.canvasPad.bottom).toBeCloseTo(tpl.canvas.pad.bottom, 6);

  // Saved at the photo's own size, the bar added below it.
  const outPath = path.join(tmp, "portrait-framed.jpg");
  await window.evaluate(async (p) => { await window.__afterframeTest.saveAs(p); }, outPath);
  const meta = await sharp(outPath).metadata();
  expect(meta.width).toBe(2064);
  expect(meta.height).toBe(Math.round(2400 + tpl.canvas.pad.bottom * 2064));
  // The band below the photo is the template's white.
  const { data, info } = await sharp(outPath).raw().toBuffer({ resolveWithObject: true });
  const idx = ((info.height - 6) * info.width + Math.floor(info.width / 2)) * info.channels;
  expect(data[idx]).toBeGreaterThan(230);
  await closeEditor();
});

test("an agent sees the user template and can apply it", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const [tpl] = await templates();
  const caps = await tool("get_editor_capabilities", {});
  expect(caps.frame_templates[0]).toMatchObject({ id: tpl.id, name: tpl.name, user: true });

  const portrait = await rowFor(PORTRAIT);
  const out = await tool("apply_frame", { asset_ids: [portrait.asset_id], template: tpl.id });
  const [result] = out.results;
  expect(result.error).toBeUndefined();
  expect(result.width).toBe(2064);
  expect(result.height).toBe(Math.round(2400 + tpl.canvas.pad.bottom * 2064));
});

test("deleting it in Settings removes it everywhere", async () => {
  const [tpl] = await templates();
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
  const row = window.locator(`[data-settings-frame-template="${tpl.id}"]`);
  await expect(row).toContainText("Bar, renamed");
  await row.getByTitle("Delete").click();
  await window.getByRole("button", { name: "Delete", exact: true }).last().click();
  await expect.poll(async () => (await templates()).length).toBe(0);
  await expect(row).toHaveCount(0);
});
