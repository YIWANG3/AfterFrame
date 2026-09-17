// HEIC (iPhone) photos end to end. Chromium cannot decode HEIC, so the app
// renders previews through sips in the sidecar and, when the lightbox asks
// for the original, main.js transcodes it to a cached JPEG behind the
// media:// protocol (transcodeHeicToJpeg) — a path no spec had exercised
// (docs/review/2026-09-17-E2E覆盖率.md, A5). The fixture is a real-camera
// JPEG re-encoded as HEIC by sips at 800px, camera EXIF intact.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

const HEIC_FIXTURE = path.resolve(__dirname, "fixtures", "heic", "iphone-style.heic");
const HEIC_CACHE = path.join(os.tmpdir(), "afterframe-heic-cache");

let ctx;
let importDir;

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test.beforeAll(async () => {
  importDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-heic-"));
  fs.copyFileSync(HEIC_FIXTURE, path.join(importDir, "IMG_4021.HEIC"));
  ctx = await launchApp({ testName: "heic" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (importDir) fs.rmSync(importDir, { recursive: true, force: true });
});

test("a HEIC imports with its camera EXIF and a sips-rendered preview", async () => {
  test.setTimeout(90_000);
  const imported = await callTool("import_directory", { image_dirs: [importDir] });
  expect(imported.status).toBe("succeeded");
  const { assets } = await callTool("search_assets", { query: "IMG_4021", limit: 5 });
  expect(assets).toHaveLength(1);
  const detail = await callTool("get_asset", { asset_id: assets[0].asset_id });
  expect(detail.image_path).toMatch(/IMG_4021\.HEIC$/);
  expect(detail.image_metadata).toMatchObject({ camera_make: "Canon", camera_model: "Canon EOS R6m2" });
  expect(fs.existsSync(detail.image_preview_path)).toBe(true);
  // The preview is a real render, not a placeholder: served as JPEG bytes.
  const response = await fetch(`http://127.0.0.1:${ctx.mcpPort}/assets/${assets[0].asset_id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/image\/jpeg/);
});

test("the lightbox shows the original through the HEIC → JPEG transcode", async () => {
  const { assets } = await callTool("search_assets", { query: "IMG_4021", limit: 5 });
  const assetId = assets[0].asset_id;
  await callTool("show_in_app", { asset_ids: [assetId] });
  const card = ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${assetId}"]`);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await card.dblclick();

  const viewport = ctx.window.locator("[data-lightbox-viewport='true']");
  const preview = viewport.locator("[data-lightbox-layer='preview']");
  await expect(preview).toBeVisible({ timeout: 5_000 });
  await expect(preview).toHaveAttribute("src", /\/previews\//);

  // The detail layer requests the .HEIC itself; main.js answers with the
  // transcoded JPEG, which is the only way Chromium can decode it.
  const detail = viewport.locator("[data-lightbox-layer='detail']");
  await expect(detail).toHaveAttribute("src", /IMG_4021\.HEIC/);
  await expect(detail).toHaveCSS("visibility", "visible", { timeout: 10_000 });
  await expect.poll(() => detail.evaluate((img) => img.naturalWidth), { timeout: 10_000 }).toBe(800);
  const cached = fs.readdirSync(HEIC_CACHE).filter((name) => name.endsWith(".jpg"));
  expect(cached.length).toBeGreaterThan(0);
});
