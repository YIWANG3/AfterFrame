// The 0.5.8 real-use review (2026-10-04, F1): while a mixed import ran from a
// hard drive, the gallery "repaired" the RAW and TIFF cards it could not show
// yet. Their thumbnails were only waiting for the import's next batch, but an
// <img> can't decode those originals, so each card's load error queued a
// refresh-assets (metadata read again, previews forced) on the resident
// sidecar: 7.0 s, 2.4 s and 29.6 s, with everything else the window asked for
// queued behind it. launchApp turns on the resident sidecar's command trace
// (AFTERFRAME_SIDECAR_TRACE), which is what these tests read.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { launchApp, closeApp, importThroughToolbar } = require("./helpers/app");

const RAW_FIXTURE = path.resolve(__dirname, "fixtures", "raw", "luna-morning.dng");

let ctx;
const resident = []; // { at, command, ms } for each command the resident sidecar answered
const ownProcess = []; // { at, line } for each command run in a process of its own

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "import-self-repair" });
  ctx.app.process().stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      const match = /\[sidecar:resident\] \S+ (\S+) in (\d+)ms/.exec(line);
      if (match) resident.push({ at: Date.now(), command: match[1], ms: Number(match[2]) });
      if (line.includes("[sidecar:async]")) ownProcess.push({ at: Date.now(), line });
    }
  });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

// TIFFs and RAWs: originals an <img> can't show, so a card has nothing to
// show until its thumbnail is made. Each file's bytes differ.
async function makeImportDir(prefix, { tiffs, raws = 0 }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${prefix}-`)));
  for (let i = 0; i < tiffs; i += 1) {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: i % 256, g: (i * 37) % 256, b: (i * 91) % 256 } } })
      .tiff().toFile(path.join(dir, `${prefix}_${String(i).padStart(3, "0")}.tif`));
  }
  for (let i = 0; i < raws; i += 1) {
    fs.writeFileSync(path.join(dir, `${prefix}_raw_${i}.dng`), Buffer.concat([fs.readFileSync(RAW_FIXTURE), Buffer.alloc(96 + i)]));
  }
  return dir;
}

const rowsUnder = (dir) => ctx.window.evaluate(async (prefix) => {
  const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 10_000 });
  return rows.filter((row) => row.image_path.startsWith(prefix)).map((row) => ({ id: row.asset_id, path: row.image_path, preview: row.preview_path }));
}, dir + path.sep);
// The cards of the photos under `dir`. A backslash starts a CSS escape, so a
// Windows path has its own doubled, as byImagePath() does.
const cardsUnder = (dir) => ctx.window.locator(`[data-gallery-item='true'][data-image-path^='${(dir + path.sep).replace(/[\\']/g, "\\$&")}']`);
const importStatus = () => ctx.window.evaluate(() => window.mediaWorkspace.getImportStatus().then((status) => status.status));
const repairsSince = (since) => resident.filter((entry) => entry.at >= since && ["refresh-assets", "generate-previews"].includes(entry.command));

test("while an import runs, the cards still waiting for their thumbnails are not repaired", async () => {
  test.setTimeout(180_000);
  const dir = await makeImportDir("pending", { tiffs: 120, raws: 6 });
  try {
    const started = Date.now();
    await importThroughToolbar(ctx.app, ctx.window, [dir]);
    // Photos in the catalog with no thumbnail yet: the import commits each one
    // as it reads it, and hands them to the thumbnail pass in batches.
    await expect.poll(async () => (await rowsUnder(dir)).filter((row) => !row.preview).length, { timeout: 60_000, intervals: [200] })
      .toBeGreaterThan(0);
    // The gallery shows them, as it does every few seconds while an import
    // runs: as on their way, without trying the originals.
    await ctx.window.evaluate(() => window.__afterframeTest.refresh());
    const cards = cardsUnder(dir);
    await expect(cards.locator("[data-preview-pending='true']").first()).toBeVisible({ timeout: 10_000 });
    await expect(cards.first()).toContainText("Preparing preview");
    await expect.poll(importStatus, { timeout: 150_000, intervals: [200] }).toBe("succeeded");
    // Nothing repaired them, and no thumbnail pass of the gallery's own ran
    // beside the import's.
    expect(repairsSince(started)).toEqual([]);
    expect(ownProcess.filter((entry) => entry.at >= started && entry.line.includes("generate-previews")).map((entry) => entry.line)).toEqual([]);

    // Every photo of the import has its thumbnail, made by the import, and the
    // cards show them.
    const rows = await rowsUnder(dir);
    expect(rows).toHaveLength(126);
    expect(rows.filter((row) => !row.preview || !fs.existsSync(row.preview)).map((row) => row.path)).toEqual([]);
    await expect(cards.locator("[data-preview-pending='true']")).toHaveCount(0, { timeout: 15_000 });
    await expect(cards.first().locator("img")).toHaveJSProperty("complete", true);
    expect(await cards.first().locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// The other half: thumbnails nothing is going to make. An import cancelled
// while it reads its first batch leaves those photos in the catalog without
// thumbnails (the 0.5.8 report cancelled one at 68/75). The gallery makes
// them, only where missing, in a background process: the resident sidecar
// answers the window meanwhile, and runs no repair.
test("photos whose import was cancelled before their thumbnails get them, made off the window's sidecar", async () => {
  test.setTimeout(180_000);
  const dir = await makeImportDir("cancelled", { tiffs: 160 });
  try {
    await importThroughToolbar(ctx.app, ctx.window, [dir]);
    await expect.poll(async () => (await rowsUnder(dir)).length, { timeout: 60_000, intervals: [100] }).toBeGreaterThan(4);
    const card = ctx.window.getByTestId("job-dock-card").first();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(importStatus, { timeout: 60_000, intervals: [200] }).toBe("cancelled");
    const cancelled = Date.now();
    const kept = await rowsUnder(dir);
    expect(kept.length).toBeLessThan(160);
    expect(kept.filter((row) => !row.preview).length, "the cancel came before the first thumbnail batch").toBeGreaterThan(0);

    await ctx.window.evaluate(() => window.__afterframeTest.refresh());
    await expect.poll(async () => (await rowsUnder(dir)).filter((row) => !row.preview || !fs.existsSync(row.preview)).length, { timeout: 60_000 })
      .toBe(0);
    // No card the gallery has drawn says it has no preview, and the first one
    // shows its thumbnail.
    const cards = cardsUnder(dir);
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    await expect(cards.filter({ hasText: "No preview" })).toHaveCount(0, { timeout: 15_000 });
    await expect(cards.first().locator("img")).toHaveJSProperty("complete", true);
    expect(await cards.first().locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    expect(repairsSince(cancelled)).toEqual([]);
    expect(ownProcess.filter((entry) => entry.at >= cancelled && entry.line.includes("generate-previews --kind preview --path")).length)
      .toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
