// Same-shot RAW+JPG pairs (docs/raw-jpg-pairing-plan.md): a camera's RAW and
// JPG of one shot, imported from the same folder, are one photo. Rating it
// rates both; Settings ▸ Library shows them as two again, with the stars
// they were given, and merging folds them again. There is no per-photo split
// (as in Lightroom): a wrong pair is fixed by showing pairs separately.
// One app launch; the tests build on each other in order.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

const RAW_FIXTURES = path.resolve(__dirname, "fixtures", "raw");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx;
let dir;

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);

async function importAndWait() {
  let status = await callTool("import_directory", { image_dirs: [dir] });
  const deadline = Date.now() + 120_000;
  while (!status.done && Date.now() < deadline) {
    await sleep(1000);
    const job = await callTool("get_job_status", { job_id: status.job_id });
    status = { ...status, done: !job.running, status: job.status, error: job.error };
  }
  expect(status.status, JSON.stringify(status)).toBe("succeeded");
}

// The shoot's photos as the gallery lists them: file name → row.
async function shoot() {
  const rows = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 500 }));
  return new Map(rows.filter((row) => row.image_path?.includes("afterframe-e2e-pairs-")).map((row) => [path.basename(row.image_path), row]));
}

async function ratingOf(assetId) {
  return ctx.window.evaluate(async (id) => (await window.mediaWorkspace.getAssetDetailById(id))?.app_rating ?? null, assetId);
}

const card = (assetId) => ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`);

async function selectCard(assetId) {
  await card(assetId).scrollIntoViewIfNeeded();
  await card(assetId).click();
  await expect(card(assetId)).toHaveAttribute("data-selected", "true");
}

async function setMergedInSettings(merged) {
  await ctx.window.evaluate(() => window.dispatchEvent(new CustomEvent("afterframe:open-settings", { detail: { tab: "library" } })));
  const row = ctx.window.getByTestId("raw-pairs-setting");
  const toggle = row.getByRole("switch");
  await expect(toggle).toBeVisible();
  await expect(row).toHaveAttribute("data-mode", /merge|separate/);
  if ((await toggle.getAttribute("aria-checked")) !== String(merged)) await toggle.click();
  await expect(row).toHaveAttribute("data-mode", merged ? "merge" : "separate");
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.locator("[data-settings-overlay]")).toHaveCount(0);
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-pairs-"));
  // What a camera set to RAW+JPEG writes: one name, two files.
  fs.copyFileSync(path.join(RAW_FIXTURES, "luna-morning.dng"), path.join(dir, "DSC_0001.DNG"));
  fs.copyFileSync(path.join(RAW_FIXTURES, "luna-morning.jpg"), path.join(dir, "DSC_0001.JPG"));
  // A RAW shot on its own stays a photo of its own.
  fs.copyFileSync(path.join(RAW_FIXTURES, "luna-evening.dng"), path.join(dir, "DSC_0002.DNG"));
  ctx = await launchApp({ testName: "raw-jpg-pairs" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("a RAW+JPG shot is one photo, badged JPG+RAW, and the import says so once", async () => {
  test.setTimeout(150_000);
  await importAndWait();
  const rows = await shoot();
  expect([...rows.keys()].sort()).toEqual(["DSC_0001.JPG", "DSC_0002.DNG"]);
  const jpg = rows.get("DSC_0001.JPG");
  expect(jpg.pair_raw_path).toMatch(/DSC_0001\.DNG$/);
  expect(rows.get("DSC_0002.DNG").pair_raw_asset_id).toBeNull();

  await expect(card(jpg.asset_id).locator("[data-raw-pair-badge]")).toBeVisible({ timeout: 20_000 });
  // "JPG+RAW", not "RAW": a RAW shot on its own is RAW too, and has no badge.
  await expect(card(jpg.asset_id).locator("[data-raw-pair-badge]")).toHaveText("JPG+RAW");
  await expect(card(rows.get("DSC_0002.DNG").asset_id).locator("[data-raw-pair-badge]")).toHaveCount(0);
  await expect(ctx.window.getByText("1 RAW+JPG pair is shown as one photo")).toBeVisible({ timeout: 10_000 });
  expect(await ctx.window.evaluate(() => window.mediaWorkspace.rawPairsStatus())).toEqual({ mode: "merge", pairs: 1, noticed: true });
});

test("rating the photo rates the RAW too; the Inspector names the RAW file, with no Split", async () => {
  const jpg = (await shoot()).get("DSC_0001.JPG");
  await selectCard(jpg.asset_id);
  await expect(ctx.window.getByTestId("inspector-raw-pair")).toContainText("DSC_0001.DNG");
  await expect(ctx.window.getByTestId("inspector-split-raw-pair")).toHaveCount(0);
  await ctx.window.keyboard.press("4");
  await expect.poll(() => ratingOf(jpg.asset_id)).toBe(4);
  expect(await ratingOf(jpg.pair_raw_asset_id), "the hidden RAW").toBe(4);
});

test("shown separately, both photos are there with their stars, and merging folds them again", async () => {
  const { pair_raw_asset_id: rawId, asset_id: jpgId } = (await shoot()).get("DSC_0001.JPG");
  await setMergedInSettings(false);
  await expect(card(rawId)).toBeVisible({ timeout: 15_000 });
  const rows = await shoot();
  expect([...rows.keys()].sort()).toEqual(["DSC_0001.DNG", "DSC_0001.JPG", "DSC_0002.DNG"]);
  expect(rows.get("DSC_0001.DNG").app_rating).toBe(4);
  await expect(card(jpgId).locator("[data-raw-pair-badge]")).toHaveCount(0);

  // Apart, a rating is the photo's own.
  await selectCard(jpgId);
  await ctx.window.keyboard.press("2");
  await expect.poll(() => ratingOf(jpgId)).toBe(2);
  expect(await ratingOf(rawId)).toBe(4);

  // Merged again: the JPG's stars win.
  await setMergedInSettings(true);
  await expect(card(rawId)).toHaveCount(0, { timeout: 15_000 });
  expect(await ratingOf(rawId)).toBe(2);
});
