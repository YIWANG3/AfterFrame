// A camera brand's frame logo, chosen by the user: give Canon one of my logos
// in the Frame tool and every Canon photo's frame shows it (templates, the
// agent's apply_frame), with Default giving Canon its own mark back; a camera
// with no built-in logo (Antigravity's make is "Yingling Innovations") is
// given one the same way. Settings › Watermark lists the library's brands.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor, mcpCall } = require("./helpers/app");

test.describe.configure({ mode: "serial" });

let app, window, userDataDir, mcpPort;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-brand-logos-"));
const SVG = path.join(tmp, "Round.svg");
const WIDE_SVG = path.join(tmp, "Wide.svg");
const DRONE_SVG = path.join(tmp, "Drone.svg");
const CANON = "0Y1A6707-9"; // Canon EOS R6m2, 2400×1600
const OTHER_CANON = "IMG_0695-Enhanced-NR-3"; // Canon EOS 6D
const UNKNOWN = "001-red"; // given Antigravity's EXIF below
const HASSELBLAD = "B0016108"; // two built-in marks: the H symbol and the wordmark
const UNKNOWN_KEY = "make:yingling innovations pte. ltd.";
let logo, wide, drone;

const rowFor = (stem) => window.evaluate(
  (s) => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }).then((rows) => rows.find((r) => r.stem === s)),
  stem,
);
const editorState = () => window.evaluate(() => window.__afterframeTest.getState());
const profile = () => window.evaluate(() => window.mediaWorkspace.getWatermarkProfile());
// The camera's logo in the frame: a logo layer that is not one of my logos.
const cameraLogoLayer = async () => (await editorState()).layers.find((l) => l.type === "sticker" && l.logoRef && l.logoRef.source !== "personal") || null;
const aspectOf = (layer) => layer.naturalWidth / layer.naturalHeight;
async function openEditorOn(stem) {
  await window.evaluate((item) => window.__afterframeTest.openEditor(item), await rowFor(stem));
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(window, { preview: true });
  await window.evaluate(() => window.__afterframeTest.setTool("frame"));
}
async function closeEditor() {
  await window.evaluate(() => window.__afterframeTest.closeEditor());
  await expect(window.getByRole("button", { name: /^Save$/i })).toHaveCount(0);
}
// The brand's logo chooser (a popover in the editor, inline in Settings):
// my logo, or null for the brand's own; picking closes it.
async function choose(scope, logoId) {
  const picker = scope.locator("[data-logo-picker]");
  await expect(picker).toBeVisible();
  await picker.locator(logoId ? `[data-pick-logo="${logoId}"]` : "[data-pick-default]").click();
  await expect(picker).toHaveCount(0);
}
const logoRow = () => window.locator("[data-my-logos]");
async function darkAt(file, { x, y }) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return Math.max(data[at], data[at + 1], data[at + 2]) < 60;
}

test.beforeAll(async () => {
  // A round one-colour mark: its shape is plainly not Canon's wordmark, and
  // its centre is filled.
  fs.writeFileSync(SVG, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#1d4ed8"/></svg>');
  fs.writeFileSync(WIDE_SVG, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="180" height="100" fill="#ffffff"/><rect x="220" width="180" height="100" fill="#ffffff"/></svg>');
  ({ app, window, userDataDir, mcpPort } = await launchApp({
    testName: "brand-logos",
    prepareCatalog(catalogDir) {
      execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), `
        UPDATE assets SET metadata_json = json_set(COALESCE(metadata_json, '{}'),
          '$.camera_make', 'Yingling Innovations Pte. Ltd.', '$.camera_model', 'antigravity a1')
          WHERE stem = '${UNKNOWN}';
      `]);
    },
  }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  ({ logo } = await window.evaluate((file) => window.mediaWorkspace.importPersonalLogo(file), SVG));
  // A white 4:1 mark (a solid block would be refused as blank: two bars).
  ({ logo: wide } = await window.evaluate((file) => window.mediaWorkspace.importPersonalLogo(file), WIDE_SVG));
  expect(logo.tintable).toBe(true);
  expect(wide.width / wide.height).toBeCloseTo(4, 1);
  fs.writeFileSync(DRONE_SVG, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><path d="M10 50 L150 10 L290 50 L150 90 Z" fill="#111"/></svg>');
  ({ logo: drone } = await window.evaluate((file) => window.mediaWorkspace.importPersonalLogo(file), DRONE_SVG));
});

test.afterAll(async () => {
  if (app) await closeApp(app, userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Canon's logo in the frame becomes mine, holding its end of the bar, and Default brings Canon's back", async () => {
  await openEditorOn(CANON);
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await expect.poll(cameraLogoLayer).not.toBeNull();
  const canon = await cameraLogoLayer();
  expect(aspectOf(canon)).toBeGreaterThan(3); // the wordmark
  const rightEdge = canon.x + canon.scale / 2;

  const row = window.locator('[data-camera-logo="canon"]');
  await expect(row).toContainText("Canon");
  // The built-in mark, one colour: drawn as a shape in the text colour.
  await expect(row.locator("[data-place-camera-logo] [data-logo-shape]")).toBeVisible();
  // Two imports that say what they are for: "My logo" here (for every photo),
  // and the camera chooser's (for this camera).
  await expect(logoRow().locator("[data-import-my-logo]")).toContainText("My logo");
  // Esc closes the chooser, not the editor.
  await row.locator("[data-change-camera-logo]").click();
  await expect(logoRow().locator("[data-logo-picker]")).toBeVisible();
  await expect(logoRow().locator("[data-logo-picker] [data-picker-import]")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(logoRow().locator("[data-logo-picker]")).toHaveCount(0);
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible();
  await row.locator("[data-change-camera-logo]").click();
  await choose(logoRow(), logo.id);
  await expect(row).toHaveAttribute("data-camera-logo-choice", logo.id);
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeCloseTo(1, 1);
  const mine = await cameraLogoLayer();
  expect(mine.x + mine.scale / 2).toBeCloseTo(rightEdge, 3); // same right end
  expect(mine.logoRef).toEqual(canon.logoRef); // still "the camera's logo", not a fixed file
  expect((await profile()).brandLogos).toEqual({ canon: logo.id });

  // Saved: the round mark is there, in the bar's colour for a logo (dark on white).
  const out = path.join(tmp, "canon-mine.jpg");
  await window.evaluate(async (p) => { await window.__afterframeTest.saveAs(p); }, out);
  const centre = { x: mine.x * 2400, y: mine.y * 1600 };
  expect(centre.y).toBeGreaterThan(1600); // in the bar
  expect(await darkAt(out, centre)).toBe(true);

  await row.locator("[data-change-camera-logo]").click();
  await choose(logoRow(), null);
  await expect(row).toHaveAttribute("data-camera-logo-choice", "");
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeGreaterThan(3);
  expect((await profile()).brandLogos).toEqual({});

  // Mine again, for the next test.
  await row.locator("[data-change-camera-logo]").click();
  await choose(logoRow(), logo.id);
  await expect(row).toHaveAttribute("data-camera-logo-choice", logo.id);
  await closeEditor();
});

test("every Canon photo's frame shows it, in the editor and through an agent's apply_frame", async () => {
  await openEditorOn(OTHER_CANON);
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await expect.poll(async () => (await cameraLogoLayer()) && aspectOf(await cameraLogoLayer())).toBeCloseTo(1, 1);
  const placed = await cameraLogoLayer();
  await closeEditor();

  const row = await rowFor(OTHER_CANON);
  const tool = async (name, args) => JSON.parse((await mcpCall(mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const { results: [result] } = await tool("apply_frame", { asset_ids: [row.asset_id], template: "bar-id" });
  expect(result.error).toBeUndefined();
  const { width } = await sharp(result.path).metadata();
  const photoH = width * (row.image_metadata.height / row.image_metadata.width);
  expect(await darkAt(result.path, { x: placed.x * width, y: placed.y * photoH })).toBe(true);
});

test("a camera with no built-in logo is given one, and it goes into the frame", async () => {
  await openEditorOn(UNKNOWN);
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await expect.poll(async () => (await editorState()).layers.length).toBeGreaterThan(0);
  expect(await cameraLogoLayer()).toBeNull(); // no mark for this camera

  const row = window.locator(`[data-camera-logo="${UNKNOWN_KEY}"]`);
  // Shown by its model; the make is in the tooltip.
  await expect(row.locator("[data-change-camera-logo]")).toContainText("antigravity a1");
  await expect(row.locator("[data-change-camera-logo]")).toHaveAttribute("title", "Yingling Innovations Pte. Ltd. · antigravity a1");
  await row.locator("[data-set-camera-logo]").click();
  // Canon's logo is Canon's: not offered to another camera.
  await expect(logoRow().locator(`[data-logo-picker] [data-pick-logo="${logo.id}"]`)).toHaveCount(0);
  await choose(logoRow(), drone.id);
  await expect(row).toHaveAttribute("data-camera-logo-choice", drone.id);
  await expect.poll(cameraLogoLayer).not.toBeNull();
  const placed = await cameraLogoLayer();
  expect(aspectOf(placed)).toBeCloseTo(drone.width / drone.height, 1);
  expect(placed.y).toBeGreaterThan(1); // in the bar
  expect((await profile()).brandLogos).toEqual({ canon: logo.id, [UNKNOWN_KEY]: drone.id });

  // Back to its own (none) takes it out of the frame.
  await row.locator("[data-change-camera-logo]").click();
  await choose(logoRow(), null);
  await expect.poll(cameraLogoLayer).toBeNull();
  await row.locator("[data-set-camera-logo]").click();
  await choose(logoRow(), drone.id);
  await expect.poll(cameraLogoLayer).not.toBeNull();
  await closeEditor();
});

test("one model has its own logo; the brand's other models keep the brand's", async () => {
  await openEditorOn(CANON); // Canon EOS R6m2
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  const row = window.locator('[data-camera-logo="canon"]');
  await expect(row.locator("[data-change-camera-logo]")).toContainText("Canon EOS R6m2");
  await row.locator("[data-change-camera-logo]").click();
  await logoRow().locator('[data-scope="model"]').click();
  await choose(logoRow(), wide.id);
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeCloseTo(4, 0);
  expect((await profile()).brandLogos).toMatchObject({ canon: logo.id, "canon#canon eos r6m2": wide.id });
  // Logos cameras use are reached through the camera's cell, not listed again.
  await expect(logoRow().locator("[data-my-logo]")).toHaveCount(0);
  await closeEditor();

  await openEditorOn(OTHER_CANON); // Canon EOS 6D: the brand's logo
  await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
  await expect.poll(async () => (await cameraLogoLayer()) && aspectOf(await cameraLogoLayer())).toBeCloseTo(1, 1);
  await closeEditor();
});

test("a brand with two marks shows both; either goes into the frame", async () => {
  await openEditorOn(HASSELBLAD);
  const row = window.locator('[data-camera-logo="hasselblad"]');
  await expect(row.locator("[data-place-camera-logo]")).toHaveCount(2);
  await row.locator('[data-place-camera-logo][data-mark="symbol"]').click();
  await expect.poll(async () => (await cameraLogoLayer())?.logoRef?.variant).toBe("symbol");
  expect(aspectOf(await cameraLogoLayer())).toBeLessThan(2); // the H
  await window.keyboard.press("Delete");
  await row.locator('[data-place-camera-logo][data-mark="wordmark"]').click();
  await expect.poll(async () => (await cameraLogoLayer())?.logoRef?.variant).toBe("wordmark");
  expect(aspectOf(await cameraLogoLayer())).toBeGreaterThan(5); // HASSELBLAD
  // Default in the chooser is both of them.
  await row.locator("[data-change-camera-logo]").click();
  await expect(logoRow().locator("[data-pick-default] [data-logo-shape]")).toHaveCount(2);
  await window.keyboard.press("Escape");
  await closeEditor();
});

test("a signature imported from the Logo row is mine for every photo, placed at once", async () => {
  const signature = path.join(tmp, "Signature.svg");
  fs.writeFileSync(signature, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><path d="M20 70 C60 10 90 90 130 40 S200 80 280 30" stroke="#111" stroke-width="8" fill="none"/></svg>');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, signature);
  const before = (await profile()).brandLogos;
  await openEditorOn(CANON);
  await logoRow().locator("[data-import-my-logo]").click();
  await expect.poll(async () => (await editorState()).layers.filter((l) => l.logoRef?.source === "personal").length).toBe(1);
  const { logos } = await window.evaluate(() => window.mediaWorkspace.listPersonalLogos());
  const mine = logos.find((l) => l.name === "Signature");
  expect(mine).toBeTruthy();
  await expect(logoRow().locator(`[data-my-logo="${mine.id}"]`)).toBeVisible(); // in the general list
  expect((await profile()).brandLogos).toEqual(before); // no camera's
  await closeEditor();
});

test("Settings › Watermark lists the library's brands and resets them", async () => {
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
  const canon = window.locator('[data-brand-logo-row="canon"]');
  const hasselblad = window.locator('[data-brand-logo-row="hasselblad"]');
  const unknown = window.locator(`[data-brand-logo-row="${UNKNOWN_KEY}"]`);
  // Every Canon photo, the frames saved above included (they keep the EXIF).
  const makes = await window.evaluate(() => window.mediaWorkspace.listCameraMakes());
  const canonCount = makes.filter((m) => m.make === "Canon").reduce((n, m) => n + m.count, 0);
  expect(canonCount).toBeGreaterThanOrEqual(2);
  await expect(canon).toContainText(`${canonCount} photos`);
  await expect(canon).toHaveAttribute("data-brand-logo-choice", logo.id);
  await expect(hasselblad).toHaveAttribute("data-brand-logo-choice", "");
  await expect(hasselblad.locator("[data-logo-shape]")).toHaveCount(2); // H and HASSELBLAD
  await expect(unknown).toContainText("antigravity a1");
  await expect(unknown).toHaveAttribute("data-brand-logo-choice", drone.id);

  await canon.locator("[data-brand-change]").click();
  await choose(canon, null);
  await expect(canon).toHaveAttribute("data-brand-logo-choice", "");
  // A logo imported from the chooser is the brand's at once (not "None"
  // until the dialog is reopened).
  const imported = path.join(tmp, "Imported.svg");
  fs.writeFileSync(imported, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><rect x="10" y="10" width="300" height="60" fill="#333"/></svg>');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imported);
  await unknown.locator("[data-brand-change]").click();
  await unknown.locator("[data-picker-import]").click();
  await expect(unknown).not.toHaveAttribute("data-brand-logo-choice", drone.id);
  await expect(unknown).toHaveAttribute("data-brand-logo-choice", /^logo_/);
  await expect(unknown.locator("[data-logo-shape], img").first()).toBeVisible();
  await unknown.locator("[data-brand-change]").click();
  await choose(unknown, null);
  await expect(unknown).toHaveAttribute("data-brand-logo-choice", "");
  // The model with its own logo is listed under its brand, by its name.
  const r6 = window.locator('[data-brand-logo-row="canon#canon eos r6m2"]');
  await expect(r6).toContainText("Canon EOS R6m2");
  await expect(r6).toHaveAttribute("data-brand-logo-choice", wide.id);
  await r6.locator("[data-brand-change]").click();
  await choose(r6, null);
  await expect(r6).toHaveCount(0);
  expect((await profile()).brandLogos).toEqual({});

  // And given one from here.
  await hasselblad.locator("[data-brand-change]").click();
  await choose(hasselblad, logo.id);
  await expect(hasselblad).toHaveAttribute("data-brand-logo-choice", logo.id);
  expect((await profile()).brandLogos).toEqual({ hasselblad: logo.id });
  await window.keyboard.press("Escape");
});

test("a choice changed where nothing announced it (a settings import) shows on the next visit to the tool", async () => {
  await openEditorOn(CANON);
  const row = window.locator('[data-camera-logo="canon"]');
  await expect(row).toHaveAttribute("data-camera-logo-choice", "");
  await window.evaluate((id) => window.mediaWorkspace.setBrandLogo("canon", id), logo.id);
  await window.evaluate(() => window.__afterframeTest.setTool("text"));
  await window.evaluate(() => window.__afterframeTest.setTool("frame"));
  await expect(row).toHaveAttribute("data-camera-logo-choice", logo.id);
  await window.evaluate(() => window.mediaWorkspace.setBrandLogo("canon", null));
  await closeEditor();
});

test("a brand with four marks: every one gets a cell, wrapping; previews show two and +2", async () => {
  // A manifest where Hasselblad has four marks, served in place of the real
  // one (main process only: nothing on disk changes).
  const dir = path.join(__dirname, "..", "frame-logos");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "logos.json"), "utf8"));
  manifest.logos.find((b) => b.id === "hasselblad").variants.push(
    { id: "extra-a", kind: "lockup", h: 0.45, file: "canon/wordmark.svg" },
    { id: "extra-b", kind: "badge", h: 0.45, file: "nikon/wordmark.svg" },
  );
  const svgs = {};
  for (const brand of manifest.logos) for (const v of brand.variants) svgs[v.file] = fs.readFileSync(path.join(dir, v.file), "utf8");
  await app.evaluate(({ ipcMain }, served) => {
    ipcMain.removeHandler("app:frame-logos");
    ipcMain.handle("app:frame-logos", () => served);
  }, { manifest, svgs });
  await window.evaluate(() => window.mediaWorkspace.setBrandLogo("hasselblad", null));
  // The registry is read once per session: start a fresh one.
  await window.reload();
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });

  await openEditorOn(HASSELBLAD);
  const cells = window.locator('[data-camera-logo="hasselblad"] [data-place-camera-logo]');
  await expect(cells).toHaveCount(4);
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => cells.nth(i).boundingBox()));
  expect(boxes[3].y).toBeGreaterThan(boxes[0].y + boxes[0].height / 2); // the fourth wraps
  for (const box of boxes) expect(box.width).toBeCloseTo(boxes[0].width, 0); // all one size
  await window.locator('[data-camera-logo="hasselblad"] [data-change-camera-logo]').click();
  await expect(logoRow().locator('[data-pick-default] [data-more-marks="2"]')).toBeVisible();
  await window.keyboard.press("Escape");
  await closeEditor();

  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
  await expect(window.locator('[data-brand-logo-row="hasselblad"] [data-more-marks="2"]')).toBeVisible();
  await window.keyboard.press("Escape");
});

