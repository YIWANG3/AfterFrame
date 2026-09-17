// The MCP tools and background jobs no spec had ever exercised
// (docs/review/2026-09-17-E2E覆盖率.md A2–A4): get_catalog_info, view_assets,
// generate_previews, delete_assets, pause_job / resume_job / cancel_job,
// index_people, plus the preview job runner (run-preview-job) through the
// renderer bridge. People indexing itself needs the 300 MB face model and
// stays out of e2e — here it must fail with the Settings → People guidance.
//
// The fixture is launched with every HD preview stripped so preview
// generation has real work to do instead of reporting "skipped".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

let ctx;

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

function makeImportDir(prefix, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${prefix}-`));
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `${prefix}_${String(i).padStart(3, "0")}.jpg`), TINY_JPEG);
  }
  return dir;
}

async function imageAssets() {
  const { assets } = await callTool("search_assets", { asset_type: "image", limit: 50, sort: "name-asc" });
  return assets;
}

test.beforeAll(async () => {
  ctx = await launchApp({
    testName: "mcp-jobs",
    prepareCatalog(catalogDir) {
      // No HD previews at all: generate_previews and the preview job must
      // actually render something below.
      execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), "DELETE FROM preview_entries WHERE kind = 'preview-hd'"]);
      fs.rmSync(path.join(catalogDir, "previews-hd"), { recursive: true, force: true });
    },
  });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("get_catalog_info reports the open catalog, its counts and search facets", async () => {
  const info = await callTool("get_catalog_info");
  expect(info.catalog_path).toMatch(/test-catalog\.afcatalog$/);
  expect(info.summary.image_assets).toBeGreaterThanOrEqual(10);
  expect(info.summary.preview_hd_ready).toBe(0); // stripped in prepareCatalog
  expect(info.facets).toBeTruthy();
});

test("view_assets returns one inline JPEG per asset and caps at eight", async () => {
  const assets = await imageAssets();
  const ids = assets.slice(0, 3).map((a) => a.asset_id);
  const three = await mcpCall(ctx.mcpPort, "tools/call", { name: "view_assets", arguments: { asset_ids: ids } });
  expect(three.isError).toBeFalsy();
  const images = three.content.filter((c) => c.type === "image");
  expect(images).toHaveLength(3);
  for (const image of images) {
    expect(image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").length).toBeGreaterThan(500);
  }
  expect(three.content.filter((c) => c.type === "text").map((c) => c.text)).toEqual(ids.map((id) => `asset ${id}:`));

  const nine = await mcpCall(ctx.mcpPort, "tools/call", { name: "view_assets", arguments: { asset_ids: assets.slice(0, 9).map((a) => a.asset_id) } });
  expect(nine.content.filter((c) => c.type === "image")).toHaveLength(8);
  expect(nine.content.at(-1).text).toMatch(/1 more ids skipped/);
});

test("generate_previews renders a missing HD preview on demand and force-regenerates the standard one", async () => {
  const [asset] = await imageAssets();
  const before = await callTool("get_asset", { asset_id: asset.asset_id });
  expect(before.image_preview_hd_path).toBeNull();

  const hd = await callTool("generate_previews", { asset_ids: [asset.asset_id] });
  expect(hd.generated).toBe(1);
  const after = await callTool("get_asset", { asset_id: asset.asset_id });
  expect(after.image_preview_hd_path).toMatch(/previews-hd/);
  expect(fs.existsSync(after.image_preview_hd_path)).toBe(true);

  const standardBefore = fs.statSync(before.image_preview_path).mtimeMs;
  const standard = await callTool("generate_previews", { asset_ids: [asset.asset_id], kind: "standard" });
  expect(standard.generated).toBe(1);
  expect(fs.statSync(before.image_preview_path).mtimeMs).toBeGreaterThan(standardBefore);
});

test("the preview job runner backfills HD previews for the whole catalog", async () => {
  test.setTimeout(90_000);
  const started = await ctx.window.evaluate(() => window.mediaWorkspace.startPreviewGeneration("preview-hd"));
  expect(started.jobId).toBeTruthy();
  expect(started.kind).toBe("preview-hd");
  await expect.poll(async () => (await ctx.window.evaluate(() => window.mediaWorkspace.getPreviewStatus())).status, { timeout: 60_000 })
    .toBe("succeeded");
  // One was rendered by generate_previews above; the job did the rest.
  const info = await callTool("get_catalog_info");
  expect(info.summary.preview_hd_ready).toBe(info.summary.image_assets);
  for (const asset of (await imageAssets()).slice(0, 3)) {
    const detail = await callTool("get_asset", { asset_id: asset.asset_id });
    expect(fs.existsSync(detail.image_preview_hd_path)).toBe(true);
  }
});

test("pause_job flags a running import, cancel_job ends it, resume_job is a no-op on a finished job", async () => {
  test.setTimeout(120_000);
  const dir = makeImportDir("ctl", 300);
  try {
    const importPromise = callTool("import_directory", { image_dirs: [dir] }).catch(() => null);
    let jobId = null;
    await expect(async () => {
      const { jobs } = await callTool("list_active_jobs");
      const job = jobs.find((j) => j.jobType === "import" && j.running);
      expect(job).toBeTruthy();
      jobId = job.jobId;
    }).toPass({ timeout: 15_000 });

    // Import runners have no pause checkpoint (only people indexing does), so
    // the request is recorded but the work continues — pin that contract. A
    // request that lands in the milliseconds before the runner's first
    // update reads 'paused' (queued jobs pause immediately); the runner then
    // sets 'running' regardless.
    const paused = await callTool("pause_job", { job_id: jobId });
    expect(paused.pause_requested).toBe(true);
    expect(["running", "paused"]).toContain(paused.status);

    const cancelled = await callTool("cancel_job", { job_id: jobId });
    expect(cancelled.cancel_requested).toBe(true);
    await expect.poll(async () => (await callTool("get_job_status", { job_id: jobId })).status, { timeout: 30_000 }).toBe("cancelled");
    await importPromise;

    const resumed = await callTool("resume_job", { job_id: jobId });
    expect(resumed.status).toBe("cancelled"); // resume only lifts 'paused'
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("index_people refuses with the Settings → People guidance when no face model is installed", async () => {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name: "index_people", arguments: {} });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/face model/i);
  await expect(ctx.window.evaluate(() => window.mediaWorkspace.startPeopleIndex({}))).rejects.toThrow(/face model/i);
});

test("delete_assets drops catalog records and previews but leaves the files on disk", async () => {
  test.setTimeout(90_000);
  const dir = makeImportDir("mcpdel", 2);
  try {
    // The gallery windows its cards, so count through the sidebar badge —
    // which also proves the renderer refreshed after the agent's import.
    const countBefore = (await callTool("get_catalog_info")).summary.image_assets;
    const imported = await callTool("import_directory", { image_dirs: [dir] });
    expect(imported.status).toBe("succeeded");
    await expect(ctx.window.getByRole("button", { name: `All Assets ${countBefore + 2}` })).toBeVisible({ timeout: 15_000 });
    const { assets } = await callTool("search_assets", { query: "mcpdel", limit: 10 });
    expect(assets).toHaveLength(2);
    const previews = await Promise.all(assets.map(async (a) => (await callTool("get_asset", { asset_id: a.asset_id })).image_preview_path));

    const deleted = await callTool("delete_assets", { asset_ids: assets.map((a) => a.asset_id) });
    expect(deleted.deleted).toBe(2);
    expect((await callTool("search_assets", { query: "mcpdel", limit: 10 })).count).toBe(0);
    await expect(ctx.window.getByRole("button", { name: `All Assets ${countBefore}` })).toBeVisible({ timeout: 15_000 });
    for (const preview of previews) expect(fs.existsSync(preview)).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(2); // originals untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
