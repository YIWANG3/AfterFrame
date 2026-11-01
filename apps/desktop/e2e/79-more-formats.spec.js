// The formats docs/format-support-plan.md §3 added (P1a), end to end: HEIF
// stills under Canon's .HIF and the generic .heif, a Photoshop file, GIF and
// BMP, a JPEG under one of its other names, and AVCHD / 3GP clips. Each
// imports with the kind its registry row says and gets a real preview; the
// PSD and a TIFF (P1c) reach the lightbox through the same JPEG render as
// HEIC (37), and
// the AVCHD clip opens in the video player (AVPlayer reads MPEG-TS on macOS;
// elsewhere Chromium can't, and the H.264 proxy takes over as for HEVC in 14).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

const FIXTURES = path.resolve(__dirname, "fixtures");
const HEIC = path.join(FIXTURES, "heic", "iphone-style.heic");
const JPEG = path.join(FIXTURES, "test-image.jpg");
const FORMATS = path.join(FIXTURES, "formats");

// name in the import folder → [fixture (null: made below), expected asset_type]
const FILES = {
  "canonstill.HIF": [HEIC, "image"],
  "genericstill.heif": [HEIC, "image"],
  "layeredpsd.psd": [path.join(FORMATS, "layered.psd"), "image"],
  "pixelgif.gif": [path.join(FORMATS, "pixel.gif"), "image"],
  "pixelbmp.bmp": [path.join(FORMATS, "pixel.bmp"), "image"],
  "panorama.insp": [JPEG, "image"],
  "scantiff.tif": [null, "image"],
  "camcorder.MTS": [path.join(FORMATS, "clip.mts"), "video"],
  "oldphone.3gp": [path.join(FORMATS, "clip.3gp"), "video"],
};

let ctx;
let importDir;

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const stem = (name) => name.slice(0, name.lastIndexOf("."));

async function assetNamed(name) {
  const { assets } = await callTool("search_assets", { query: stem(name), limit: 5 });
  expect(assets, name).toHaveLength(1);
  return callTool("get_asset", { asset_id: assets[0].asset_id });
}

test.beforeAll(async () => {
  importDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-formats-"));
  for (const [name, [fixture]] of Object.entries(FILES)) if (fixture) fs.copyFileSync(fixture, path.join(importDir, name));
  // A scanner's 16-bit TIFF, the kind no browser decodes.
  await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 180, g: 120, b: 60 } } })
    .toColourspace("rgb16").tiff({ compression: "lzw" }).toFile(path.join(importDir, "scantiff.tif"));
  ctx = await launchApp({ testName: "more-formats" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (importDir) fs.rmSync(importDir, { recursive: true, force: true });
});

test("every added format imports as its kind, with a rendered preview", async () => {
  test.setTimeout(120_000);
  const imported = await callTool("import_directory", { image_dirs: [importDir] });
  expect(imported.status).toBe("succeeded");
  for (const [name, [, kind]] of Object.entries(FILES)) {
    const detail = await assetNamed(name);
    expect(detail.image_path, name).toMatch(new RegExp(`${name.replace(".", "\\.")}$`));
    expect(detail.asset_type, name).toBe(kind);
    expect(fs.existsSync(detail.image_preview_path), name).toBe(true);
    // A real render (the poster frame, for a clip), served as JPEG bytes.
    const response = await fetch(`http://127.0.0.1:${ctx.mcpPort}/assets/${detail.asset_id}`);
    expect(response.status, name).toBe(200);
    expect(response.headers.get("content-type"), name).toMatch(/image\/jpeg/);
  }
  // The HEIF stills carry the camera EXIF the HEIC fixture has.
  const hif = await assetNamed("canonstill.HIF");
  expect(hif.image_metadata).toMatchObject({ camera_make: "Canon", camera_model: "Canon EOS R6m2" });
});

// The detail layer asks for the original itself; media:// answers with a
// full-size JPEG render of it, cached under userData.
for (const [name, width] of [["layeredpsd.psd", 320], ["scantiff.tif", 320]]) {
  test(`the lightbox shows the original of ${name} through the JPEG render`, async () => {
    const { asset_id: assetId } = await assetNamed(name);
    await callTool("show_in_app", { asset_ids: [assetId] });
    const card = ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${assetId}"]`);
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.dblclick();

    const viewport = ctx.window.locator("[data-lightbox-viewport='true']");
    const detail = viewport.locator("[data-lightbox-layer='detail']");
    await expect(detail).toHaveAttribute("src", new RegExp(name.replace(".", "\\.")));
    await expect(detail).toHaveCSS("visibility", "visible", { timeout: 10_000 });
    await expect.poll(() => detail.evaluate((img) => img.naturalWidth), { timeout: 10_000 }).toBe(width);
    await ctx.window.keyboard.press("Escape");
  });
}

test("the renders sit in one cache under userData, not the temp folder", async () => {
  const cache = path.join(ctx.userDataDir, "transcode-cache");
  const renders = fs.readdirSync(cache).filter((file) => file.endsWith(".jpg") && !file.startsWith("."));
  expect(renders.length).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(os.tmpdir(), "afterframe-heic-cache"))).toBe(false);
});

test("an AVCHD clip opens in the video player with its duration", async () => {
  const { asset_id: assetId } = await assetNamed("camcorder.MTS");
  await callTool("show_in_app", { asset_ids: [assetId] });
  const card = ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${assetId}"]`);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card.getByText("0:03")).toBeVisible();
  await card.dblclick();

  const video = ctx.window.locator("[data-video-engine]");
  await expect(video).toBeVisible({ timeout: 15_000 });
  await expect(ctx.window.getByLabel("Seek")).toBeVisible();
  if (process.platform === "darwin") {
    // AVFoundation reads MPEG-TS: the clip plays natively, no proxy needed.
    await expect(video).toHaveAttribute("data-video-engine", "avplayer");
    await expect(video).toHaveAttribute("data-video-ready", "true", { timeout: 15_000 });
  }
  await ctx.window.keyboard.press("Escape");
  await expect(video).toHaveCount(0);
});
