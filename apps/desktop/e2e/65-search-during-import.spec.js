// The 0.5.8 real-use review (test priority 9: search, selection and filters
// while an import runs). During a large CR3 import, a search for DSC08452 first
// showed its two ARWs; after selecting them, Select All and the context menu,
// the grid also showed a duplicate "DSC08452 2.ARW" and DSC08453 and DSC08454,
// with the box still reading DSC08452. The identical-bytes RAW part was fixed
// by #156; the rest was never reproduced on its own.
//
// Here an import keeps running, and the gallery keeps refreshing (every 4 s),
// while the search, the selection, Select All, the context menu and a filter
// are used. The grid is sampled throughout: only matching photos, each once,
// the selection kept, the search box unchanged.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, importThroughToolbar } = require("./helpers/app");

const RAW_FIXTURE = path.resolve(__dirname, "fixtures", "raw", "luna-morning.dng");
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);
// Files per background import: long enough for several of the gallery's
// refreshes (tiny files import at about 2 ms each locally, 5 ms on CI).
const BULK = 6000;
const QUERY = "DSC08452";

let ctx;
const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${prefix}-`)));
  tempDirs.push(dir);
  return dir;
}

// A camera card's worth of RAWs already in the catalog: DSC08450–DSC08454,
// and a Finder duplicate of DSC08452 (the same bytes, "DSC08452 2").
function writeTargets() {
  const dir = tempDir("targets");
  const raw = fs.readFileSync(RAW_FIXTURE);
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(dir, `DSC0845${i}.dng`), Buffer.concat([raw, Buffer.alloc(96 + i)]));
  }
  fs.copyFileSync(path.join(dir, "DSC08452.dng"), path.join(dir, "DSC08452 2.dng"));
  return dir;
}

// What keeps an import running: tiny JPEGs. The import reads a folder in name
// order, so `extra` (name suffix → bytes) lands that far into it: photos that
// arrive while the view is already narrowed.
function writeBulk(prefix, extra = {}) {
  const dir = tempDir(prefix);
  for (let i = 0; i < BULK; i += 1) fs.writeFileSync(path.join(dir, `${prefix}_${String(i).padStart(4, "0")}.jpg`), TINY_JPEG);
  for (const [suffix, bytes] of Object.entries(extra)) fs.writeFileSync(path.join(dir, `${prefix}_${suffix}`), bytes);
  return dir;
}

const importStatus = () => ctx.window.evaluate(() => window.mediaWorkspace.getImportStatus().then((status) => status.status));
const grid = () => ctx.window.evaluate(() => ({
  query: document.querySelector("input[placeholder='Search']")?.value ?? null,
  cards: [...document.querySelectorAll("[data-gallery-item='true']")].map((el) => ({
    id: el.dataset.assetId,
    name: (el.dataset.imagePath || "").split(/[\\/]/).pop(),
    selected: el.dataset.selected === "true",
  })),
}));

// Samples the grid until the import has ended and the gallery's refresh after
// it has landed, and returns every sample that broke a rule.
async function watchGrid(rules, { settleMs = 5_000 } = {}) {
  const broken = [];
  const timeline = []; // { running, cards: [names] } per sample
  let endedAt = null;
  for (;;) {
    const state = await grid();
    const running = ["running", "queued"].includes(await importStatus());
    timeline.push({ running, cards: state.cards.map((c) => c.name) });
    for (const problem of rules(state)) broken.push({ sample: timeline.length, problem, cards: state.cards.map((c) => c.name) });
    if (endedAt === null && !running) endedAt = Date.now();
    if (endedAt !== null && Date.now() - endedAt > settleMs) break;
    await ctx.window.waitForTimeout(250);
  }
  return { broken, timeline };
}
// Whether the grid took in a photo that arrived while it was narrowed, with
// the import still running: the gallery's own refreshes kept the narrowing.
const grewWhileRunning = (timeline, matches) => {
  const first = timeline[0].cards.filter(matches).length;
  return timeline.some((sample) => sample.running && sample.cards.filter(matches).length > first);
};

function duplicates(cards) {
  const seen = new Set();
  return cards.filter((card) => (seen.has(card.id) ? true : (seen.add(card.id), false))).map((card) => card.name);
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "search-during-import" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  const targets = writeTargets();
  await importThroughToolbar(ctx.app, ctx.window, [targets]);
  await expect.poll(() => ctx.window.evaluate(async (prefix) => {
    const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 1000 });
    return rows.filter((row) => row.image_path.startsWith(prefix)).length;
  }, targets + path.sep), { timeout: 60_000, intervals: [250] }).toBe(6);
  await expect.poll(importStatus, { timeout: 60_000, intervals: [250] }).toBe("succeeded");
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a search, a selection, Select All and the context menu hold while an import runs", async () => {
  test.setTimeout(240_000);
  const cards = ctx.window.locator("[data-gallery-item='true']");
  const search = ctx.window.getByPlaceholder("Search");
  const bursts = [2000, 3000, 4000].map((n) => `bulk_${n}_${QUERY}.jpg`);
  await importThroughToolbar(ctx.app, ctx.window, [writeBulk("bulk", Object.fromEntries(bursts.map((name) => [name.slice("bulk_".length), TINY_JPEG])))]);
  await expect.poll(importStatus, { timeout: 30_000, intervals: [100] }).toBe("running");

  await search.fill(QUERY);
  await expect(cards.filter({ hasText: "DSC08452 2" })).toHaveCount(1, { timeout: 15_000 });
  await expect(cards.filter({ hasText: "DSC08452.dng" })).toHaveCount(1);

  // One photo, then all of them, then the context menu on the selection.
  await cards.filter({ hasText: "DSC08452.dng" }).click();
  await ctx.window.keyboard.press("ControlOrMeta+a");
  const afterSelectAll = (await grid()).cards;
  const chosen = afterSelectAll.filter((card) => card.selected).map((card) => card.id);
  expect(chosen.length).toBe(afterSelectAll.length);
  // On a chosen card: a photo that has just arrived sits first (newest import
  // first), and right-clicking it would choose it instead.
  await ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${chosen[0]}"]`).click({ button: "right" });
  await expect(ctx.window.getByText("Copy File Path", { exact: true })).toBeVisible();
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByText("Copy File Path", { exact: true })).toHaveCount(0);
  expect(await importStatus(), "the import ran through all of it").toBe("running");

  const { broken, timeline } = await watchGrid((state) => {
    const problems = [];
    const names = state.cards.map((card) => card.name);
    if (state.query !== QUERY) problems.push(`search box reads ${JSON.stringify(state.query)}`);
    for (const name of names) if (!name.includes(QUERY)) problems.push(`${name} doesn't match`);
    for (const name of ["DSC08452.dng", "DSC08452 2.dng"]) if (!names.includes(name)) problems.push(`${name} is gone`);
    for (const name of duplicates(state.cards)) problems.push(`${name} shown twice`);
    const selected = new Set(state.cards.filter((card) => card.selected).map((card) => card.id));
    for (const id of chosen) if (!selected.has(id)) problems.push(`selection lost ${id}`);
    return problems;
  });
  expect(broken).toEqual([]);
  expect(grewWhileRunning(timeline, (name) => bursts.includes(name)), "a matching photo arrived and showed while the import ran").toBe(true);

  // The search's photos once the import is done: the RAW pair and the three
  // that arrived while it ran, each once.
  const final = await grid();
  expect(final.cards.map((card) => card.name).sort()).toEqual(["DSC08452 2.dng", "DSC08452.dng", ...bursts].sort());
  expect(duplicates(final.cards)).toEqual([]);

  await search.fill("");
  await expect(search).toHaveValue("");
});

test("a filter holds while an import runs", async () => {
  test.setTimeout(240_000);
  const cards = ctx.window.locator("[data-gallery-item='true']");
  await ctx.window.getByRole("button", { name: /^All Assets/ }).first().click();
  if (!await ctx.window.locator("[data-filter-bar]").isVisible()) await ctx.window.getByRole("button", { name: "Filters" }).click();
  const raw = Buffer.concat([fs.readFileSync(RAW_FIXTURE), Buffer.alloc(200)]);
  await importThroughToolbar(ctx.app, ctx.window, [writeBulk("more", { "3000_raw.dng": raw })]);
  await expect.poll(importStatus, { timeout: 30_000, intervals: [100] }).toBe("running");

  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "Format", exact: true }).click();
  await ctx.window.locator('[data-facet-option="DNG"]').click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards.filter({ hasText: "DSC0845" })).toHaveCount(6, { timeout: 15_000 });
  expect(await importStatus(), "the import ran through it").toBe("running");

  const { broken, timeline } = await watchGrid((state) => {
    const problems = [];
    const names = state.cards.map((card) => card.name);
    for (const name of names) if (!name.toLowerCase().endsWith(".dng")) problems.push(`${name} isn't a DNG`);
    if (names.filter((name) => name.startsWith("DSC0845")).length !== 6) problems.push("a DNG from before is gone");
    for (const name of duplicates(state.cards)) problems.push(`${name} shown twice`);
    return problems;
  });
  expect(broken).toEqual([]);
  expect(grewWhileRunning(timeline, (name) => name === "more_3000_raw.dng"), "the new DNG showed while the import ran").toBe(true);
  await expect(cards).toHaveCount(7);
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});
