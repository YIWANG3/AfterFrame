// Camera logos and custom logos (docs/next-features-plan.md §E).
// A camera logo is one brand's: at the brand level (every model of it: mine
// in place of Canon's own marks, Default gives them back) or the model level
// (this model only; models named the same are one camera, a drone's lenses).
// Templates use the model's, else the brand's. A custom logo (a signature)
// is for every photo and never offered as a camera's. Frame text names the
// camera as the app shows it (Canon's R6m2 as R6 Mark II, a drone's camera
// code by the name table, or the user's name).
// Settings › Watermark lists brands with their models, to rename and choose.

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
const svgFile = (name, body) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" ${body}</svg>`);
  return file;
};
const CANON = "0Y1A6707-9"; // Canon EOS R6m2, 2400×1600
const OTHER_CANON = "IMG_0695-Enhanced-NR-3"; // Canon EOS 6D
const UNKNOWN = "001-red"; // given a maker with no built-in logo below
const AIR_WIDE = "002-orange"; // given the DJI Air 3S's two cameras below:
const AIR_TELE = "004-green"; // FC9113 (24mm) and FC9184 (70mm)
const HASSELBLAD = "B0016108"; // CFV 100C/907X; two built-in marks: the H and the wordmark
const UNKNOWN_KEY = "make:acme optics";
const R6_KEY = "canon#canon eos r6m2";
const SIXD_KEY = "canon#canon eos 6d";
let round; // Canon's brand logo of mine (1:1)
let wide; // the R6m2's model logo (4:1)
let drone; // the Acme's (3:1)
let signature; // custom

const rowFor = (stem) => window.evaluate(
  (s) => window.mediaWorkspace.browseImages({ status: "all", limit: 100 }).then((rows) => rows.find((r) => r.stem === s)),
  stem,
);
const editorState = () => window.evaluate(() => window.__afterframeTest.getState());
const profile = () => window.evaluate(() => window.mediaWorkspace.getWatermarkProfile());
const importLogo = (options) => window.evaluate((o) => window.mediaWorkspace.importPersonalLogo(o), options).then((res) => res.logo);
const stubDialog = (files) => app.evaluate(({ dialog }, picked) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked }); }, files);
// Camera logo layers (not my custom ones), in the order placed.
const cameraLogoLayers = async () => (await editorState()).layers.filter((l) => l.type === "sticker" && l.logoRef && l.logoRef.source !== "personal");
const cameraLogoLayer = async () => (await cameraLogoLayers())[0] || null;
const aspectOf = (layer) => layer.naturalWidth / layer.naturalHeight;
const camera = () => window.locator("[data-camera-logos]");
const brandRow = () => camera().locator('[data-camera-level="brand"]');
const modelRow = () => camera().locator('[data-camera-level="model"]');
const customRow = () => window.locator("[data-my-logos]");
async function openEditorOn(stem, preset) {
  await window.evaluate((item) => window.__afterframeTest.openEditor(item), await rowFor(stem));
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(window, { preview: true });
  await window.evaluate(() => window.__afterframeTest.setTool("frame"));
  if (preset) await window.evaluate((id) => window.__afterframeTest.applyFramePreset(id), preset);
}
async function closeEditor() {
  await window.evaluate(() => window.__afterframeTest.closeEditor());
  await expect(window.getByRole("button", { name: /^Save$/i })).toHaveCount(0);
}
// A chooser (a popover in the editor, inline in Settings): a logo, or null
// for Default; picking closes it.
async function choose(scope, logoId) {
  const picker = scope.locator("[data-logo-picker]");
  await expect(picker).toBeVisible();
  await picker.locator(logoId ? `[data-pick-logo="${logoId}"]` : "[data-pick-default]").click();
  await expect(picker).toHaveCount(0);
}
async function openWatermarkSettings() {
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Watermark" }).click();
}
async function darkAt(file, { x, y }) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return Math.max(data[at], data[at + 1], data[at + 2]) < 60;
}

test.beforeAll(async () => {
  ({ app, window, userDataDir, mcpPort } = await launchApp({
    testName: "brand-logos",
    prepareCatalog(catalogDir) {
      execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), `
        UPDATE assets SET metadata_json = json_set(COALESCE(metadata_json, '{}'),
          '$.camera_make', 'Acme Optics', '$.camera_model', 'Acme One')
          WHERE stem = '${UNKNOWN}';
        UPDATE assets SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.camera_make', 'DJI', '$.camera_model', 'FC9113')
          WHERE stem = '${AIR_WIDE}';
        UPDATE assets SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.camera_make', 'DJI', '$.camera_model', 'FC9184')
          WHERE stem = '${AIR_TELE}';
      `]);
    },
  }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  // Camera logos, each its brand's (as a chooser's upload makes them).
  round = await importLogo({ filePath: svgFile("Round.svg", 'viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#1d4ed8"/>'), kind: "camera", brand: "canon" });
  wide = await importLogo({ filePath: svgFile("Wide.svg", 'viewBox="0 0 400 100"><rect width="180" height="100" fill="#fff"/><rect x="220" width="180" height="100" fill="#fff"/>'), kind: "camera", brand: "canon" });
  drone = await importLogo({ filePath: svgFile("Drone.svg", 'viewBox="0 0 300 100"><path d="M10 50 L150 10 L290 50 L150 90 Z" fill="#111"/>'), kind: "camera", brand: UNKNOWN_KEY });
  expect(round).toMatchObject({ kind: "camera", brand: "canon", tintable: true });
  expect(drone).toMatchObject({ kind: "camera", brand: UNKNOWN_KEY });
});

test.afterAll(async () => {
  if (app) await closeApp(app, userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Canon's brand logo becomes mine, holding its end of the bar; Default brings Canon's back", async () => {
  await openEditorOn(CANON, "bar-id");
  await expect.poll(cameraLogoLayer).not.toBeNull();
  const canon = await cameraLogoLayer();
  expect(aspectOf(canon)).toBeGreaterThan(3); // the wordmark
  const rightEdge = canon.x + canon.scale / 2;
  // Frame text names the camera as the app does: Canon's R6m2 is the R6 Mark II.
  expect((await editorState()).layers.map((l) => l.text)).toContain("Canon EOS R6 Mark II");

  await expect(camera()).toHaveAttribute("data-camera-logo", "canon");
  await expect(brandRow().locator("[data-place-camera-logo] [data-logo-shape]")).toBeVisible(); // the built-in mark
  await expect(modelRow().locator('[data-change-camera-logo="model"]')).toContainText("Canon EOS R6 Mark II");
  await expect(modelRow().locator('[data-set-camera-logo="model"]')).toBeVisible(); // no model logo yet
  // Camera logos are not custom ones.
  await expect(customRow().locator(`[data-my-logo="${round.id}"]`)).toHaveCount(0);

  // Esc closes a chooser, not the editor.
  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await expect(camera().locator("[data-logo-picker]")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(camera().locator("[data-logo-picker]")).toHaveCount(0);
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible();

  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await expect(camera().locator("[data-logo-picker] [data-picker-import]")).toBeVisible();
  await choose(camera(), round.id);
  await expect(brandRow()).toHaveAttribute("data-camera-logo-choice", round.id);
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeCloseTo(1, 1);
  const mine = await cameraLogoLayer();
  expect(mine.x + mine.scale / 2).toBeCloseTo(rightEdge, 3); // same right end
  expect((await profile()).brandLogos).toEqual({ canon: round.id });

  const out = path.join(tmp, "canon-mine.jpg");
  await window.evaluate(async (p) => { await window.__afterframeTest.saveAs(p); }, out);
  expect(await darkAt(out, { x: mine.x * 2400, y: mine.y * 1600 })).toBe(true); // dark on the white bar

  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await choose(camera(), null);
  await expect(brandRow()).toHaveAttribute("data-camera-logo-choice", "");
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeGreaterThan(3);
  expect((await profile()).brandLogos).toEqual({});

  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await choose(camera(), round.id); // mine again, for what follows
  await closeEditor();
});

test("every Canon photo gets the brand's logo, in the editor and through an agent's apply_frame", async () => {
  await openEditorOn(OTHER_CANON, "bar-id");
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

test("a model logo is that model's alone; a mark placed from the brand row stays the brand's", async () => {
  await openEditorOn(CANON, "bar-id"); // the R6m2
  await modelRow().locator('[data-set-camera-logo="model"]').click();
  // A model's Default is the brand's.
  await expect(camera().locator("[data-logo-picker] [data-pick-default]")).toBeVisible();
  await choose(camera(), wide.id);
  await expect(modelRow()).toHaveAttribute("data-camera-logo-choice", wide.id);
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeCloseTo(4, 0); // templates use the model's
  expect((await profile()).brandLogos).toEqual({ canon: round.id, [R6_KEY]: wide.id });

  await brandRow().locator("[data-place-camera-logo]").first().click();
  await expect.poll(async () => (await cameraLogoLayers()).length).toBe(2);
  const fromBrandRow = (await cameraLogoLayers())[1];
  expect(fromBrandRow.logoRef.scope).toBe("brand");
  expect(aspectOf(fromBrandRow)).toBeCloseTo(1, 1); // the brand's (round), not the model's
  await closeEditor();

  await openEditorOn(OTHER_CANON, "bar-id"); // the 6D: no model logo, the brand's
  await expect.poll(async () => (await cameraLogoLayer()) && aspectOf(await cameraLogoLayer())).toBeCloseTo(1, 1);
  await expect(modelRow()).toHaveAttribute("data-camera-logo-choice", "");
  await closeEditor();
});

test("models named the same are one camera: they share a model logo, and frame text uses the name", async () => {
  await window.evaluate(([a, b]) => Promise.all([
    window.mediaWorkspace.setCameraName(a, "Twin"), window.mediaWorkspace.setCameraName(b, "Twin"),
  ]), [R6_KEY, SIXD_KEY]);
  await openEditorOn(OTHER_CANON, "bar-id"); // the 6D, now named like the R6m2
  await expect(modelRow().locator('[data-change-camera-logo="model"]')).toContainText("Twin");
  await expect.poll(async () => (await cameraLogoLayer()) && aspectOf(await cameraLogoLayer())).toBeCloseTo(4, 0); // the R6m2's
  await expect(modelRow()).toHaveAttribute("data-camera-logo-choice", wide.id);
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain("Twin");
  // Default on one takes it off both.
  await modelRow().locator('[data-change-camera-logo="model"]').click();
  await choose(camera(), null);
  await expect.poll(async () => (await profile()).brandLogos).toEqual({ canon: round.id });
  await closeEditor();
  await window.evaluate(([a, b]) => Promise.all([
    window.mediaWorkspace.setCameraName(a, null), window.mediaWorkspace.setCameraName(b, null),
  ]), [R6_KEY, SIXD_KEY]);
  await window.evaluate(([key, id]) => window.mediaWorkspace.setBrandLogo(key, id), [R6_KEY, wide.id]);
});

test("a drone's two cameras, one to the name table: frame text names the drone, one model logo serves both", async () => {
  const lens = await importLogo({ filePath: svgFile("Air.svg", 'viewBox="0 0 200 100"><rect width="90" height="100" fill="#fff"/><rect x="110" width="90" height="100" fill="#fff"/>'), kind: "camera", brand: "dji" });
  await openEditorOn(AIR_WIDE, "bar-id");
  await expect(modelRow().locator('[data-change-camera-logo="model"]')).toContainText("DJI Air 3S");
  await expect.poll(async () => (await editorState()).layers.map((l) => l.text)).toContain("DJI Air 3S");
  await modelRow().locator('[data-set-camera-logo="model"]').click();
  await choose(camera(), lens.id);
  await expect.poll(async () => aspectOf(await cameraLogoLayer())).toBeCloseTo(2, 0);
  expect((await profile()).brandLogos).toMatchObject({ "dji#fc9113": lens.id }); // kept on the one it was chosen on
  await closeEditor();

  await openEditorOn(AIR_TELE, "bar-id"); // the other camera
  await expect(modelRow()).toHaveAttribute("data-camera-logo-choice", lens.id);
  await expect.poll(async () => (await cameraLogoLayer()) && aspectOf(await cameraLogoLayer())).toBeCloseTo(2, 0);
  // Default here takes it off the drone.
  await modelRow().locator('[data-change-camera-logo="model"]').click();
  await choose(camera(), null);
  await expect.poll(async () => Object.keys((await profile()).brandLogos).filter((key) => key.startsWith("dji"))).toEqual([]);
  await closeEditor();
});

test("a camera with no built-in logo is given one of its own; Canon's are not offered", async () => {
  await openEditorOn(UNKNOWN, "bar-id");
  await expect.poll(async () => (await editorState()).layers.length).toBeGreaterThan(0);
  expect(await cameraLogoLayer()).toBeNull();
  await expect(brandRow().locator('[data-change-camera-logo="brand"]')).toContainText("Acme Optics"); // its make, as written
  await brandRow().locator('[data-set-camera-logo="brand"]').click();
  await expect(camera().locator(`[data-logo-picker] [data-pick-logo="${round.id}"]`)).toHaveCount(0);
  await choose(camera(), drone.id);
  await expect(brandRow()).toHaveAttribute("data-camera-logo-choice", drone.id);
  await expect.poll(cameraLogoLayer).not.toBeNull(); // a frame without one gets it placed
  expect(aspectOf(await cameraLogoLayer())).toBeCloseTo(drone.width / drone.height, 1);
  // Default (none) takes it out of the frame.
  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await choose(camera(), null);
  await expect.poll(cameraLogoLayer).toBeNull();
  await brandRow().locator('[data-set-camera-logo="brand"]').click();
  await choose(camera(), drone.id);
  await closeEditor();
});

test("custom logos: uploaded from their row, several at once, for every photo, never a camera's", async () => {
  const sig = svgFile("Signature.svg", 'viewBox="0 0 300 100"><path d="M20 70 C60 10 90 90 130 40 S200 80 280 30" stroke="#111" stroke-width="8" fill="none"/>');
  await stubDialog([sig]);
  const before = (await profile()).brandLogos;
  await openEditorOn(CANON);
  await customRow().locator("[data-import-my-logo]").click();
  await expect.poll(async () => (await editorState()).layers.filter((l) => l.logoRef?.source === "personal").length).toBe(1); // placed
  signature = (await window.evaluate(() => window.mediaWorkspace.listPersonalLogos())).logos.find((l) => l.name === "Signature");
  expect(signature).toMatchObject({ kind: "custom" });
  await expect(customRow().locator(`[data-my-logo="${signature.id}"]`)).toBeVisible();
  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await expect(camera().locator(`[data-logo-picker] [data-pick-logo="${signature.id}"]`)).toHaveCount(0);
  await window.keyboard.press("Escape");
  expect((await profile()).brandLogos).toEqual(before);

  // Two at once: both kept, neither placed.
  await stubDialog([svgFile("Studio A.svg", 'viewBox="0 0 200 60"><rect x="5" y="5" width="190" height="50" rx="8" fill="#222"/>'),
    svgFile("Studio B.svg", 'viewBox="0 0 60 60"><circle cx="30" cy="30" r="25" fill="#222"/>')]);
  await customRow().locator("[data-import-my-logo]").click();
  // Two SVGs through sharp: 4 s on a quick runner, past 15 s on a slow one.
  await expect(customRow().locator("[data-my-logo]")).toHaveCount(3, { timeout: 30_000 });
  expect((await editorState()).layers.filter((l) => l.logoRef?.source === "personal")).toHaveLength(1);
  await closeEditor();
});

test("a brand with two marks shows both; either goes into the frame", async () => {
  await openEditorOn(HASSELBLAD);
  await expect(brandRow().locator("[data-place-camera-logo]")).toHaveCount(2);
  await brandRow().locator('[data-place-camera-logo][data-mark="symbol"]').click();
  await expect.poll(async () => (await cameraLogoLayer())?.logoRef?.variant).toBe("symbol");
  expect(aspectOf(await cameraLogoLayer())).toBeLessThan(2); // the H
  await window.keyboard.press("Delete");
  await brandRow().locator('[data-place-camera-logo][data-mark="wordmark"]').click();
  await expect.poll(async () => (await cameraLogoLayer())?.logoRef?.variant).toBe("wordmark");
  expect(aspectOf(await cameraLogoLayer())).toBeGreaterThan(5); // HASSELBLAD
  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await expect(camera().locator("[data-pick-default] [data-logo-shape]")).toHaveCount(2); // Default: both
  await window.keyboard.press("Escape");
  await closeEditor();
});

test("a choice changed where nothing announced it (a settings import) shows on the next visit to the tool", async () => {
  await openEditorOn(OTHER_CANON);
  await expect(brandRow()).toHaveAttribute("data-camera-logo-choice", round.id);
  await window.evaluate(() => window.mediaWorkspace.setBrandLogo("canon", null));
  await window.evaluate(() => window.__afterframeTest.setTool("text"));
  await window.evaluate(() => window.__afterframeTest.setTool("frame"));
  await expect(brandRow()).toHaveAttribute("data-camera-logo-choice", "");
  await window.evaluate((id) => window.mediaWorkspace.setBrandLogo("canon", id), round.id);
  await closeEditor();
});

test("Settings › Watermark: brands with their models, renamed and reset there; custom logos apart", async () => {
  await openWatermarkSettings();
  // Custom logos only in the custom group.
  await expect(window.locator(`[data-settings-logo="${signature.id}"]`)).toBeVisible();
  await expect(window.locator(`[data-settings-logo="${round.id}"]`)).toHaveCount(0);

  const canon = window.locator('[data-brand-logo-row="canon"]');
  const r6 = window.locator(`[data-brand-logo-row="${R6_KEY}"]`);
  const cfv = window.locator('[data-brand-logo-row="hasselblad#cfv 100c/907x"]');
  const unknown = window.locator(`[data-brand-logo-row="${UNKNOWN_KEY}"]`);
  // Every Canon photo, the frames saved above included (they keep the EXIF).
  const makes = await window.evaluate(() => window.mediaWorkspace.listCameraMakes());
  const canonCount = makes.filter((m) => m.make === "Canon").reduce((n, m) => n + m.count, 0);
  await expect(canon).toContainText(`${canonCount} photos`);
  await expect(canon).toHaveAttribute("data-brand-logo-choice", round.id);
  await expect(r6).toContainText("Canon EOS R6 Mark II"); // shown as the app names it
  await expect(r6).toContainText("Canon EOS R6m2"); // with what EXIF says beside it
  await expect(r6).toHaveAttribute("data-brand-logo-choice", wide.id);
  await expect(unknown).toHaveAttribute("data-brand-logo-choice", drone.id);
  await expect(unknown.locator("[data-rename-camera]").first()).toContainText("Acme Optics");

  // Rename a model: Hasselblad's back as the body it is on.
  await cfv.locator("[data-rename-camera]").click();
  await cfv.locator("input").fill("907X");
  await cfv.locator("input").press("Enter");
  // "CFV 100C/907X" already contains 907X: wait for the save, not the text.
  await expect.poll(async () => (await profile()).cameraNames).toEqual({ "hasselblad#cfv 100c/907x": "907X" });
  await expect(cfv.locator("[data-rename-camera]")).toHaveText(/^907X/);

  // An upload from a chooser is that brand's camera logo, chosen at once.
  const uploaded = svgFile("Uploaded.svg", 'viewBox="0 0 320 80"><rect x="10" y="10" width="300" height="60" fill="#333"/>');
  await stubDialog([uploaded]);
  await unknown.locator("[data-brand-change]").click();
  await unknown.locator("[data-picker-import]").click();
  await expect(unknown).not.toHaveAttribute("data-brand-logo-choice", drone.id);
  await expect(unknown).toHaveAttribute("data-brand-logo-choice", /^logo_/);
  await expect(unknown.locator("[data-logo-shape], img").first()).toBeVisible();
  const made = (await window.evaluate(() => window.mediaWorkspace.listPersonalLogos())).logos.find((l) => l.name === "Uploaded");
  expect(made).toMatchObject({ kind: "camera", brand: UNKNOWN_KEY });

  // Default everywhere.
  for (const row of [canon, r6, unknown]) {
    await row.locator("[data-brand-change]").first().click();
    await choose(row, null);
    await expect(row).toHaveAttribute("data-brand-logo-choice", "");
  }
  expect((await profile()).brandLogos).toEqual({});
  await expect(r6).toBeVisible(); // a model stays listed, following its brand
  await window.keyboard.press("Escape");
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
  // The registry is read once per session: start a fresh one.
  await window.reload();
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });

  await openEditorOn(HASSELBLAD);
  const cells = brandRow().locator("[data-place-camera-logo]");
  await expect(cells).toHaveCount(4);
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => cells.nth(i).boundingBox()));
  expect(boxes[3].y).toBeGreaterThan(boxes[0].y + boxes[0].height / 2); // the fourth wraps
  for (const box of boxes) expect(box.width).toBeCloseTo(boxes[0].width, 0); // all one size
  await brandRow().locator('[data-change-camera-logo="brand"]').click();
  await expect(camera().locator('[data-pick-default] [data-more-marks="2"]')).toBeVisible();
  await window.keyboard.press("Escape");
  await closeEditor();

  await openWatermarkSettings();
  await expect(window.locator('[data-brand-logo-row="hasselblad"] [data-more-marks="2"]')).toBeVisible();
  await window.keyboard.press("Escape");
});
