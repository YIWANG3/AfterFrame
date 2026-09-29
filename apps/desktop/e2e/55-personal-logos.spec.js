// My logos (docs/next-features-plan.md §E step 7): import your own SVG or PNG,
// place it on a frame (recoloured when it is one colour), save that as a
// template, and it travels with the template, onto another photo and through
// apply_frame. Deleting the logo leaves the templates working without it.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor, mcpCall } = require("./helpers/app");

// Each test builds on the one before (the imported logo, the saved template).
test.describe.configure({ mode: "serial" });

let app, window, userDataDir, mcpPort;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-personal-logos-"));
const SVG = path.join(tmp, "Studio Mark.svg");
const PNG = path.join(tmp, "two-colour.png");
const BAD = path.join(tmp, "not-an-image.png");
const LANDSCAPE = "0Y1A6707-9";
const PORTRAIT = "B0016108"; // 2064×2400
let svgLogo;

const rowFor = (stem) => window.evaluate(
  (s) => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }).then((rows) => rows.find((r) => r.stem === s)),
  stem,
);
const editorState = () => window.evaluate(() => window.__afterframeTest.getState());
const templates = () => window.evaluate(() => window.mediaWorkspace.listFrameTemplates());
async function openEditorOn(stem) {
  await window.evaluate((item) => window.__afterframeTest.openEditor(item), await rowFor(stem));
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(window, { preview: true });
  await window.evaluate(() => window.__afterframeTest.setTool("text"));
}
async function closeEditor() {
  await window.evaluate(() => window.__afterframeTest.closeEditor());
  await expect(window.getByRole("button", { name: /^Save$/i })).toHaveCount(0);
}
async function openWatermarkSettings() {
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
}
const personalLayers = (state) => state.layers.filter((l) => l.logoRef?.source === "personal");

test.beforeAll(async () => {
  // A one-colour mark (its <script> is never run: the file is rasterized) and a two-colour one.
  fs.writeFileSync(SVG, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><script>alert(1)</script>'
    + '<rect x="10" y="10" width="220" height="60" rx="10" fill="#1d4ed8"/></svg>');
  await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="300" height="100"><rect x="10" y="10" width="120" height="80" fill="red"/><rect x="150" y="10" width="120" height="80" fill="#0a0"/></svg>') }])
    .png().toFile(PNG);
  fs.writeFileSync(BAD, "not an image");
  ({ app, window, userDataDir, mcpPort } = await launchApp({ testName: "personal-logos" }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (app) await closeApp(app, userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("an SVG and a PNG import; one colour can be recoloured, two cannot; junk is refused", async () => {
  const importLogo = (p) => window.evaluate((file) => window.mediaWorkspace.importPersonalLogo(file), p);
  ({ logo: svgLogo } = await importLogo(SVG));
  expect(svgLogo).toMatchObject({ name: "Studio Mark", tintable: true, color: "#1d4ed8" });
  expect(svgLogo.path.endsWith(".png")).toBe(true);
  expect((await importLogo(PNG)).logo.tintable).toBe(false);
  expect(await importLogo(BAD)).toEqual({ error: "invalid_image" });

  await openWatermarkSettings();
  await expect(window.locator("[data-settings-logo]")).toHaveCount(2);
  await expect(window.locator(`[data-settings-logo="${svgLogo.id}"]`)).toContainText("Recolourable");
  await window.keyboard.press("Escape");
});

test("placed in black on a bar and saved as a template, the logo goes with the template", async () => {
  await openEditorOn(LANDSCAPE);
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await window.getByTitle("My logo").click();
  await window.locator(`[data-personal-logo="${svgLogo.id}"] [data-logo-tint="black"]`).click();
  await expect.poll(async () => personalLayers(await editorState()).length).toBe(1);
  expect(personalLayers(await editorState())[0]).toMatchObject({
    stickerPathKind: "data", logoRef: { source: "personal", id: svgLogo.id, color: "#141414" },
  });

  await window.locator("[data-save-frame-template]").click();
  await window.locator("[data-frame-template-name] input").fill("With my logo");
  await window.locator("[data-frame-template-name] input").press("Enter");
  await expect.poll(async () => (await templates()).length).toBe(1);
  const [tpl] = await templates();
  expect(tpl.layers.find((l) => l.logoRef?.source === "personal")).toMatchObject({ logoRef: { id: svgLogo.id, color: "#141414" } });
  expect(JSON.stringify(tpl)).not.toContain("data:");
  await closeEditor();

  // Another photo, another shape: the logo is there, black, where it was
  // pinned: the centre of the whole output, bar included.
  await openEditorOn(PORTRAIT);
  await window.evaluate((id) => window.__afterframeTest.applyFramePreset(id), tpl.id);
  await expect.poll(async () => personalLayers(await editorState()).length).toBe(1);
  const out = path.join(tmp, "portrait-with-logo.jpg");
  await window.evaluate(async (p) => { await window.__afterframeTest.saveAs(p); }, out);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(info.height / 2) * info.width + Math.round(info.width / 2)) * info.channels;
  expect(Math.max(data[at], data[at + 1], data[at + 2])).toBeLessThan(60);
  await closeEditor();
});

test("an agent's apply_frame renders the template with the logo", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const [tpl] = await templates();
  const portrait = await rowFor(PORTRAIT);
  const { results: [result] } = await tool("apply_frame", { asset_ids: [portrait.asset_id], template: tpl.id });
  expect(result.error).toBeUndefined();
  const { data, info } = await sharp(result.path).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(info.height / 2) * info.width + Math.round(info.width / 2)) * info.channels;
  expect(Math.max(data[at], data[at + 1], data[at + 2])).toBeLessThan(60);
});

test("deleting the logo leaves the template working without it", async () => {
  await openWatermarkSettings();
  const row = window.locator(`[data-settings-logo="${svgLogo.id}"]`);
  await row.getByTitle("Delete").click();
  await window.getByRole("button", { name: "Delete", exact: true }).last().click();
  await expect(row).toHaveCount(0);
  await window.keyboard.press("Escape");

  const [tpl] = await templates();
  await openEditorOn(LANDSCAPE);
  await window.evaluate((id) => window.__afterframeTest.applyFramePreset(id), tpl.id);
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain("Canon EOS R6m2");
  expect(personalLayers(await editorState())).toHaveLength(0);
  await closeEditor();
});
