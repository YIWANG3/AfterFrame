// RAW import and pairing, end to end. The catalog's headline feature (RAW ↔
// JPEG reverse lookup) had zero e2e coverage: scanner.py, the whole
// reverse_lookup scorer, file_types RAW detection and the enrichment runner
// never ran under Playwright (docs/review/2026-09-17-E2E覆盖率.md, A1/A2).
//
// Fixtures: two real Insta360 DNGs shrunk to ~200 KB by Adobe DNG Converter
// (fixtures/raw/make-raw-fixtures.py) — real camera EXIF, decodable by Image
// I/O, so sips previews and native dimensions work like on a user's library.
// The JPEGs are derived here at setup so their names/EXIF pick the pairing
// outcome deterministically (scorer weights in reverse_lookup.score_candidate):
//   luna-morning.jpg     sips export of luna-morning.dng: same stem, same EXIF
//                        → 0.99, auto_bound
//   luna-evening-2.jpg   pixels of luna-evening.dng re-encoded WITHOUT EXIF and
//                        cropped square: stem_key strips the "-2" (exact stem
//                        0.62 + alnum 0.14 + similarity 0.12), no time, no
//                        camera, aspect mismatch → 0.88, pending_confirmation
//   sunset-edit.jpg      unrelated name, no EXIF → filename-family veto, unmatched
// One app launch; the tests build on each other in order.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall, waitForEditor } = require("./helpers/app");

const RAW_FIXTURES = path.resolve(__dirname, "fixtures", "raw");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
let work; // { root, rawDir, jpgDir, browseDir }

async function tool(name, args) {
  const response = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args });
  expect(response.isError, `${name}: ${JSON.stringify(response.content)}`).toBeFalsy();
  return JSON.parse(response.content[0].text);
}

// import_directory waits up to ~25s itself; keep polling get_job_status after.
async function importAndWait(args) {
  let status = await tool("import_directory", args);
  const deadline = Date.now() + 90_000;
  while (!status.done && Date.now() < deadline) {
    await sleep(1500);
    const job = await tool("get_job_status", { job_id: status.job_id });
    status = { ...status, done: !job.running, status: job.status, error: job.error, result: job.result };
  }
  expect(status.status, JSON.stringify(status)).toBe("succeeded");
  // { key, label, result } per phase, keyed for the assertions.
  status.phases = Object.fromEntries((status.result?.phase_results || []).map((p) => [p.key, p.result]));
  return status;
}

async function browseByName() {
  const rows = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 200 }));
  return new Map(rows.map((row) => [path.basename(row.image_path), row]));
}

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-raw-"));
  const rawDir = path.join(root, "raw");
  const jpgDir = path.join(root, "exports");
  const browseDir = path.join(root, "raw-as-photos");
  for (const dir of [rawDir, jpgDir, browseDir]) fs.mkdirSync(dir);
  for (const name of ["luna-morning.dng", "luna-evening.dng"]) {
    fs.copyFileSync(path.join(RAW_FIXTURES, name), path.join(rawDir, name));
  }
  // sips keeps the camera EXIF (make/model/capture time) — the export a real
  // RAW converter would produce.
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1024", "--out", path.join(jpgDir, "luna-morning.jpg"), path.join(rawDir, "luna-morning.dng")], { stdio: "ignore" });
  const eveningTmp = path.join(root, "evening-tmp.jpg");
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1024", "--out", eveningTmp, path.join(rawDir, "luna-evening.dng")], { stdio: "ignore" });
  // sharp drops EXIF unless asked to keep it; the square crop breaks the aspect feature.
  await sharp(eveningTmp).extract({ left: 224, top: 0, width: 576, height: 576 }).jpeg().toFile(path.join(jpgDir, "luna-evening-2.jpg"));
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 230, g: 120, b: 40 } } }).jpeg().toFile(path.join(jpgDir, "sunset-edit.jpg"));
  // A RAW imported as a PHOTO (image_dirs) must not share bytes with a RAW
  // registered as a SOURCE (raw_dirs): asset ids are content fingerprints and
  // the photo path deliberately evicts its id from the candidate pool. A few
  // trailing bytes change the fingerprint; TIFF readers ignore them.
  fs.writeFileSync(path.join(browseDir, "luna-browse.dng"), Buffer.concat([fs.readFileSync(path.join(RAW_FIXTURES, "luna-evening.dng")), Buffer.alloc(64)]));
  work = { root, rawDir, jpgDir, browseDir };

  ctx = await launchApp({ testName: "raw-import" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (work) fs.rmSync(work.root, { recursive: true, force: true });
});

test("combined import: RAW sources are scanned and each JPEG lands on the right pairing outcome", async () => {
  test.setTimeout(150_000);
  const status = await importAndWait({ raw_dirs: [work.rawDir], image_dirs: [work.jpgDir] });
  expect(status.phases.scan_sources, JSON.stringify(status.result)).toMatchObject({ indexed: 2, discovered: 2 });
  expect(status.phases.match_processed_media).toMatchObject({
    processed: 3,
    status_counts: { auto_bound: 1, pending_confirmation: 1, unmatched: 1 },
  });
  expect(status.phases.generate_previews).toMatchObject({ generated: 3, failed: 0 });

  const rows = await browseByName();
  expect([...rows.keys()].sort()).toEqual(["luna-evening-2.jpg", "luna-morning.jpg", "sunset-edit.jpg"].concat(
    // the seeded catalog's own 10 images are still there
    [...rows.keys()].filter((n) => !n.startsWith("luna") && !n.startsWith("sunset")),
  ).sort());

  const morning = rows.get("luna-morning.jpg");
  expect(morning.match_status).toBe("auto_bound");
  expect(morning.raw_path).toMatch(/luna-morning\.dng$/);
  expect(Number(morning.score)).toBeGreaterThanOrEqual(0.9);

  const evening = rows.get("luna-evening-2.jpg");
  expect(evening.match_status).toBe("pending_confirmation");
  expect(Number(evening.score)).toBeGreaterThanOrEqual(0.7);
  expect(Number(evening.score)).toBeLessThan(0.9);

  const sunset = rows.get("sunset-edit.jpg");
  expect(sunset.match_status).toBe("unmatched");
  expect(sunset.raw_path).toBeNull();

  // get_asset exposes the scorer's reasoning: the winning candidate and features.
  const detail = await tool("get_asset", { asset_id: morning.asset_id });
  expect(detail.candidates[0].path).toMatch(/luna-morning\.dng$/);
  expect(detail.feature_vector).toMatchObject({ exact_stem_key: 1, capture_time: 1, camera_model: 1 });
  expect(detail.raw_metadata).toMatchObject({ camera_model: "Luna Ultra" });
});

test("status scopes split paired from unpaired", async () => {
  const matched = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "matched", limit: 200 }));
  expect(matched.map((r) => path.basename(r.image_path))).toEqual(["luna-morning.jpg"]);
  const unmatched = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "unmatched", limit: 200 }));
  expect(unmatched.map((r) => path.basename(r.image_path)).filter((n) => n.startsWith("luna") || n.startsWith("sunset")).sort())
    .toEqual(["luna-evening-2.jpg", "sunset-edit.jpg"]);
  const viaMcp = await tool("search_assets", { status: "matched", limit: 50 });
  expect(viaMcp.assets.map((a) => a.asset_id)).toEqual(matched.map((r) => r.asset_id));
});

test("raw_pairing lists the ambiguous match; confirm_match settles it and links the assets", async () => {
  const pending = await tool("raw_pairing", { action: "list_pending" });
  expect(pending.count).toBe(1);
  const [entry] = pending.pending;
  expect(entry.image_path).toMatch(/luna-evening-2\.jpg$/);
  expect(entry.candidates.length).toBeGreaterThanOrEqual(1);
  expect(entry.candidates[0].path).toMatch(/luna-evening\.dng$/);

  const confirmed = await tool("raw_pairing", { action: "confirm_match", image_path: entry.image_path, raw_asset_id: entry.candidates[0].raw_asset_id });
  expect(confirmed).toBeTruthy();

  const detail = await tool("get_asset", { asset_id: entry.image_asset_id });
  expect(detail.match_status).toBe("manual_confirmed");
  expect(detail.raw_path).toMatch(/luna-evening\.dng$/);
  expect((await tool("raw_pairing", { action: "list_pending" })).count).toBe(0);
  const matched = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "matched", limit: 200 }));
  expect(matched.map((r) => path.basename(r.image_path)).sort()).toEqual(["luna-evening-2.jpg", "luna-morning.jpg"]);
});

test("the Inspector shows the paired RAW as the source", async () => {
  const rows = await browseByName();
  const morning = rows.get("luna-morning.jpg");
  await tool("show_in_app", { asset_ids: [morning.asset_id] });
  await expect(ctx.window.locator(`[data-asset-id="${morning.asset_id}"][data-selected='true']`)).toBeVisible({ timeout: 5_000 });
  await expect(ctx.window.getByText("RAW Source")).toBeVisible({ timeout: 5_000 });
  await expect(ctx.window.getByRole("button", { name: /luna-morning\.dng/ })).toBeVisible();

  const sunset = rows.get("sunset-edit.jpg");
  await tool("show_in_app", { asset_ids: [sunset.asset_id] });
  await expect(ctx.window.locator(`[data-asset-id="${sunset.asset_id}"][data-selected='true']`)).toBeVisible({ timeout: 5_000 });
  await expect(ctx.window.getByText("Not linked")).toBeVisible({ timeout: 5_000 });
});

test("enrichment upgrades the matcher-profile RAW scan to full metadata", async () => {
  test.setTimeout(90_000);
  // The import scans RAW with the cheap "matcher" profile; enrichment is the
  // second pass that reads the full EXIF set. Never started by any other spec.
  const started = await ctx.window.evaluate(() => window.mediaWorkspace.startEnrichment());
  expect(started.jobId).toBeTruthy();
  await expect.poll(async () => (await ctx.window.evaluate(() => window.mediaWorkspace.getEnrichmentStatus())).status, { timeout: 60_000 })
    .toBe("succeeded");
  const rows = await browseByName();
  const detail = await tool("get_asset", { asset_id: rows.get("luna-morning.jpg").asset_id });
  expect(detail.raw_metadata).toMatchObject({ camera_make: "Insta360", camera_model: "Luna Ultra", iso: 275 });
});

test("a RAW imported as a photo is browseable with a rendered preview and native dimensions", async () => {
  test.setTimeout(150_000);
  await importAndWait({ image_dirs: [work.browseDir] });
  const rows = await browseByName();
  const raw = rows.get("luna-browse.dng");
  expect(raw, [...rows.keys()].join(",")).toBeTruthy();
  expect(raw.asset_type).toBe("raw");
  expect(raw.match_status).toBe("unmatched");

  const detail = await tool("get_asset", { asset_id: raw.asset_id });
  expect(detail.image_metadata).toMatchObject({ width: 1024, height: 576, camera_model: "Luna Ultra" });
  expect(detail.image_preview_path).toBeTruthy();

  // The preview is what the gallery and MCP clients see — served like any photo.
  const response = await fetch(`http://127.0.0.1:${ctx.mcpPort}/assets/${raw.asset_id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/image\/jpeg/);
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(2000);

  await tool("show_in_app", { asset_ids: [raw.asset_id] });
  await expect(ctx.window.locator(`[data-asset-id="${raw.asset_id}"]`)).toBeVisible({ timeout: 5_000 });
});

test("a RAW's HD preview is made when the lightbox opens it, not at import", async () => {
  test.setTimeout(90_000);
  const raw = (await browseByName()).get("luna-browse.dng");
  expect((await tool("get_asset", { asset_id: raw.asset_id })).image_preview_hd_path).toBeFalsy();

  await tool("show_in_app", { asset_ids: [raw.asset_id] });
  await ctx.window.locator(`[data-asset-id="${raw.asset_id}"]`).dblclick();
  const viewport = ctx.window.locator("[data-lightbox-viewport='true']");
  await expect(viewport.locator("[data-lightbox-layer='preview']")).toHaveAttribute("src", /\/previews\//, { timeout: 10_000 });
  // It arrives after the thumbnail, as the detail layer an image's original would be.
  await expect(viewport.locator("[data-lightbox-layer='detail']")).toHaveAttribute("src", /\/previews-hd\//, { timeout: 60_000 });
  expect((await tool("get_asset", { asset_id: raw.asset_id })).image_preview_hd_path).toMatch(/previews-hd/);
  await ctx.window.keyboard.press("Escape");
});

test("byte-identical RAW copies are two photos, and their cards hold still", async () => {
  test.setTimeout(150_000);
  // A re-downloaded "B0000333 (1).3FR": the same bytes, its own mtime. Keyed
  // by content, both were one asset whose mtime matched only one file; the
  // other card read as changed on disk, and the gallery repaired and
  // re-rendered both every couple of seconds.
  const dupDir = path.join(work.root, "copies");
  fs.mkdirSync(dupDir);
  // Trailing bytes keep them apart from the RAW sources' fingerprints.
  const bytes = Buffer.concat([fs.readFileSync(path.join(RAW_FIXTURES, "luna-morning.dng")), Buffer.alloc(128)]);
  const names = ["B0000333.dng", "B0000333 (1).dng"];
  names.forEach((name, n) => {
    const file = path.join(dupDir, name);
    fs.writeFileSync(file, bytes);
    const mtime = new Date(1_700_000_000_000 + n * 4000);
    fs.utimesSync(file, mtime, mtime);
  });
  await importAndWait({ image_dirs: [dupDir] });

  const all = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 200 }));
  const cards = names.map((name) => all.filter((row) => path.basename(row.image_path) === name));
  expect(cards.map((rows) => rows.length)).toEqual([1, 1]);
  const [original, copy] = cards.map(([row]) => row);
  expect(original.asset_id).not.toBe(copy.asset_id);
  expect([original.source_changed, copy.source_changed]).toEqual([false, false]);

  // Their previews load once and stay put: no repair re-renders them. Cards
  // are found by file, since a shared asset id is the bug.
  await tool("show_in_app", { asset_ids: [original.asset_id] });
  const paths = [original.image_path, copy.image_path];
  const loadedSources = () => ctx.window.evaluate((wanted) => wanted.map((imagePath) => {
    const card = [...document.querySelectorAll("[data-image-path]")].find((el) => el.dataset.imagePath === imagePath);
    const img = card?.querySelector("img");
    return img?.classList.contains("opacity-100") ? img.getAttribute("src") : null;
  }), paths);
  await expect.poll(async () => (await loadedSources()).every(Boolean), { timeout: 15_000 }).toBe(true);
  const seen = paths.map(() => new Set());
  for (let tick = 0; tick < 40; tick += 1) {
    (await loadedSources()).forEach((src, n) => seen[n].add(src ?? "(blank)"));
    await sleep(100);
  }
  expect(seen.map((set) => set.size), JSON.stringify(seen.map((set) => [...set]))).toEqual([1, 1]);
});

// The 0.5.8 report: two ARWs compared from the context menu showed two broken
// images. Compare handed the RAW file itself to an <img>.
test("Compare shows RAWs decoded — two RAWs, and a RAW beside a JPEG — and zooms both sides together", async () => {
  test.setTimeout(120_000);
  const rows = await browseByName();
  const card = (row) => ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${row.asset_id}"]`);
  const images = () => ctx.window.getByTestId("compare-image");
  const decoded = () => images().evaluateAll((els) => els.map((img) => ({
    src: decodeURIComponent(img.getAttribute("src") || ""), ok: img.complete && img.naturalWidth > 0,
  })));
  async function compare(a, b) {
    await tool("show_in_app", { asset_ids: [a.asset_id] });
    await card(a).click();
    await card(b).click({ modifiers: ["Meta"] });
    await expect(ctx.window.locator("[data-gallery-item='true'][data-selected='true']")).toHaveCount(2);
    await card(b).click({ button: "right" });
    await ctx.window.getByText("Compare", { exact: true }).click();
    await expect(ctx.window.getByTestId("compare-header")).toBeVisible();
    await expect(images()).toHaveCount(2);
  }

  const [rawA, rawB] = ["B0000333.dng", "B0000333 (1).dng"].map((name) => rows.get(name));
  await compare(rawA, rawB);
  // Both sides decode, and neither is the RAW file.
  await expect.poll(async () => (await decoded()).every((side) => side.ok && !/\.dng$/i.test(side.src)), { timeout: 15_000 }).toBe(true);
  // The HD previews are made on demand and take over, as in the lightbox.
  await expect.poll(async () => (await decoded()).every((side) => side.ok && side.src.includes("/previews-hd/")), { timeout: 60_000 }).toBe(true);
  // Each side is named by its file, not "Before" / "After".
  await expect(images().nth(0)).toHaveAttribute("alt", "B0000333.dng");
  await expect(images().nth(1)).toHaveAttribute("alt", "B0000333 (1).dng");

  // One wheel turn zooms both, around the same point; switching layout keeps them decoded.
  await images().first().hover();
  await ctx.window.mouse.wheel(0, -120);
  const transforms = () => images().evaluateAll((els) => els.map((img) => img.style.transform));
  await expect.poll(async () => (await transforms())[0]).toMatch(/scale\(1\.0[0-9]+\)/);
  const [first, second] = await transforms();
  expect(second).toBe(first);
  await ctx.window.getByTestId("compare-layout-controls").getByRole("button").nth(1).click();
  await expect.poll(async () => (await decoded()).every((side) => side.ok)).toBe(true);
  await ctx.window.getByTestId("compare-close").click();
  await expect(ctx.window.getByTestId("compare-header")).toHaveCount(0);

  // A RAW beside a JPEG: the JPEG side is its original, the RAW side a preview.
  const raw = rows.get("luna-browse.dng");
  const jpeg = rows.get("luna-morning.jpg");
  await compare(raw, jpeg);
  await expect.poll(async () => {
    const sides = await decoded();
    return sides.every((side) => side.ok)
      && sides.some((side) => side.src.endsWith("/luna-morning.jpg"))
      && !sides.some((side) => /\.dng$/i.test(side.src));
  }, { timeout: 30_000 }).toBe(true);
  await ctx.window.getByTestId("compare-close").click();
});

// The 0.5.8 report: JPEGs exported from a CR2 and a RAF in the editor showed
// "RAW source: not linked" — registered against the preview they were drawn
// from, not the RAW.
test("an export saved from the editor on a RAW names that RAW as its source and leads back to it", async () => {
  test.setTimeout(120_000);
  const raw = (await browseByName()).get("luna-browse.dng");
  const out = path.join(fs.realpathSync(work.root), "luna-browse_edited.jpg");
  await tool("show_in_app", { asset_ids: [raw.asset_id] });
  await ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${raw.asset_id}"]`).click();
  await expect(ctx.window.getByTestId("inspector-asset-title")).toHaveText("luna-browse.dng");
  await ctx.window.keyboard.press("e");
  await expect(ctx.window.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 30_000 });
  await waitForEditor(ctx.window, { preview: true, previewTimeout: 60_000 });

  await ctx.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, out);
  await ctx.window.getByRole("button", { name: /^Save$/ }).click();
  await expect(ctx.window.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  expect(fs.existsSync(out)).toBe(true);
  // Untouched, so the RAW's own size: this RAW's HD preview is a full-size render.
  expect(await sharp(out).metadata()).toMatchObject({ width: 1024, height: 576 });

  const detail = await ctx.window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), out);
  expect(detail.raw_path).toBe(raw.image_path);
  expect(detail.raw_asset_id).toBe(raw.asset_id);
  expect(detail.match_status).toBe("manual_confirmed");
  expect(detail.raw_in_library).toBe(true);
  await ctx.window.keyboard.press("Escape");
  await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);

  // The export's Inspector names the RAW, and one click opens it in the gallery.
  await tool("show_in_app", { asset_ids: [detail.asset_id] });
  await expect(ctx.window.getByTestId("inspector-asset-title")).toHaveText("luna-browse_edited.jpg", { timeout: 10_000 });
  await expect(ctx.window.getByTestId("inspector-raw-source")).toContainText("luna-browse.dng");
  await ctx.window.getByTestId("inspector-show-raw").click();
  await expect(ctx.window.getByTestId("inspector-asset-title")).toHaveText("luna-browse.dng", { timeout: 10_000 });
  await expect(ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${raw.asset_id}"][data-selected='true']`)).toBeVisible();
});
