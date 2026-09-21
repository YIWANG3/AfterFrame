// The filter bar and the search box inside a folder. They used to do nothing
// there: browse-collection took neither, so the chips looked active while the
// grid kept showing the whole folder — and the dropdowns kept quoting the
// library's counts (a camera reading "1794" inside a folder of 40 photos).

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

let ctx;
let members;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const cardIds = () => cards().evaluateAll((els) => els.map((el) => el.dataset.assetId).sort());

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "folder-filters" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  // The folder is made the way a user makes one: the sidebar's New folder button.
  await ctx.window.getByTitle("New folder").click();
  const nameInput = ctx.window.getByRole("navigation").locator("input");
  await nameInput.fill("Filter me");
  await nameInput.press("Enter");
  await expect(ctx.window.getByRole("button", { name: /^Filter me/ })).toBeVisible();
  // Four photos in it: two rated five stars, two rated one.
  members = await ctx.window.evaluate(async () => {
    const bridge = window.mediaWorkspace;
    const all = (await bridge.browseImages({ status: "all", limit: 100, sort: "name-asc" })).filter((r) => r.asset_type !== "video");
    // Two of the fixture's three photos that carry a camera, plus two that do
    // not: the folder's camera counts then differ from the library's.
    // Not B0016108: the startup self-heal refreshes it from disk (see #80), and
    // a refresh that lands after the ratings below would put its file's five
    // stars back.
    const withCamera = all.filter((r) => r.image_metadata?.camera_model && r.stem !== "B0016108");
    const rows = [...all.filter((r) => !r.image_metadata?.camera_model).slice(0, 2), ...withCamera.slice(0, 2)];
    const folder = (await bridge.listCollections()).find((c) => c.name === "Filter me");
    await bridge.collectionAddItems(folder.collection_id, rows.map((r) => r.asset_id));
    await bridge.setAssetRating(rows.slice(0, 2).map((r) => r.asset_id), 5);
    // (The fixture ships some of these at five stars; pin every rating explicitly.)
    await bridge.setAssetRating(rows.slice(2).map((r) => r.asset_id), 1);
    return rows.map((r) => ({ id: r.asset_id, stem: r.stem }));
  });
  await ctx.window.getByRole("button", { name: /^Filter me/ }).click();
  await expect(cards()).toHaveCount(4);
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a rating filter narrows the folder, and clearing it brings the folder back", async () => {
  await ctx.window.getByRole("button", { name: "Filters" }).click();
  await ctx.window.getByTitle("Rating ≥ 5").click();
  await expect(cards()).toHaveCount(2);
  expect(await cardIds()).toEqual(members.slice(0, 2).map((m) => m.id).sort());
  // Still inside the folder: the filter narrowed it, it did not leave it.
  await expect(ctx.window.getByRole("button", { name: /^Filter me/ })).toHaveClass(/bg-selected/);

  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
  await expect(cards()).toHaveCount(4);
});

test("search inside a folder is answered by the catalog, not just the loaded page", async () => {
  const target = members[3];
  await ctx.window.getByPlaceholder("Search").fill(target.stem);
  await expect(cards()).toHaveCount(1);
  expect(await cardIds()).toEqual([target.id]);
  // The sidecar itself narrows: the same query straight over the bridge.
  const direct = await ctx.window.evaluate(({ stem }) => window.mediaWorkspace.listCollections()
    .then((cols) => window.mediaWorkspace.browseCollection(cols.find((c) => c.name === "Filter me").collection_id, { search: stem, limit: 50 }))
    .then((rows) => rows.map((r) => r.asset_id)), target);
  expect(direct).toEqual([target.id]);
  await ctx.window.getByPlaceholder("Search").fill("");
  await expect(cards()).toHaveCount(4);
});

test("a filter nothing in the folder matches shows an empty folder, not the whole one", async () => {
  await ctx.window.evaluate((ids) => window.mediaWorkspace.setAssetRating(ids, 3), members.slice(0, 2).map((m) => m.id));
  await ctx.window.getByTitle("Rating ≥ 5").click();
  await expect(cards()).toHaveCount(0);
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
  await expect(cards()).toHaveCount(4);
});

// Camera → count, as the open Camera dropdown shows it.
async function cameraCounts() {
  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "Camera", exact: true }).click();
  const options = ctx.window.locator("[data-facet-option]");
  await expect(options.first()).toBeVisible();
  const counts = await options.evaluateAll((els) => Object.fromEntries(els.map((el) => [el.dataset.facetOption, Number(el.dataset.facetCount)])));
  await ctx.window.keyboard.press("Escape");
  return counts;
}

test("the dropdown counts describe the folder, and each count is what choosing it shows", async () => {
  // What the folder really holds, per camera, straight from the catalog.
  const expected = await ctx.window.evaluate(async () => {
    const bridge = window.mediaWorkspace;
    const folder = (await bridge.listCollections()).find((c) => c.name === "Filter me");
    const rows = await bridge.browseCollection(folder.collection_id, { limit: 100 });
    const counts = {};
    for (const row of rows) {
      const camera = row.image_metadata?.camera_model;
      if (camera) counts[camera] = (counts[camera] || 0) + 1;
    }
    return counts;
  });
  expect(Object.keys(expected).length).toBeGreaterThan(0);

  const inFolder = await cameraCounts();
  expect(inFolder).toEqual(expected);

  // Choosing an option shows exactly that many photos.
  const [camera, count] = Object.entries(inFolder)[0];
  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "Camera", exact: true }).click();
  await ctx.window.locator(`[data-facet-option="${camera}"]`).click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(count);
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();

  // Back in the library the same dropdown quotes the library again.
  await ctx.window.getByRole("button", { name: "All Assets" }).click();
  const inLibrary = await cameraCounts();
  const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
  expect(total(inLibrary)).toBeGreaterThan(total(inFolder));
  expect(inLibrary[camera]).toBeGreaterThanOrEqual(count);
});
