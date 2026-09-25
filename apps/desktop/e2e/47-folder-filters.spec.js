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
  // Right after launch the create waits on the serial sidecar behind the
  // startup work (self-heal refresh, facet counts): seconds on CI runners.
  await expect(ctx.window.getByRole("button", { name: /^Filter me/ })).toBeVisible({ timeout: 15_000 });
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

test("an active filter keeps the bar on screen: it cannot be hidden while it is filtering", async () => {
  await ctx.window.getByTitle("Rating ≥ 5").click();
  await ctx.window.getByRole("button", { name: "Filters" }).click(); // try to hide it
  await expect(ctx.window.locator("[data-filter-bar]")).toBeVisible();
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
  // Nothing filtering any more: the toggle is the user's again. Put it back for the tests below.
  if (!await ctx.window.locator("[data-filter-bar]").isVisible()) await ctx.window.getByRole("button", { name: "Filters" }).click();
  await expect(ctx.window.locator("[data-filter-bar]")).toBeVisible();
});

test("a folder follows the toolbar's sort, and offers its own added order only there", async () => {
  const stems = () => cards().evaluateAll((els) => els.map((el) => el.dataset.assetId));
  const byStem = Object.fromEntries(members.map((m) => [m.id, m.stem]));
  const sortTo = async (label) => {
    await ctx.window.getByRole("button", { name: /^(Imported|Captured|Added|Name|Rating)/ }).first().click();
    await ctx.window.getByRole("button", { name: label, exact: true }).click();
  };
  await sortTo("Name A-Z");
  await expect.poll(async () => (await stems()).map((id) => byStem[id])).toEqual(members.map((m) => m.stem).sort((a, b) => a.localeCompare(b)));
  await sortTo("Name Z-A");
  await expect.poll(async () => (await stems()).map((id) => byStem[id])).toEqual(members.map((m) => m.stem).sort((a, b) => b.localeCompare(a)));
  // "Added" exists here…
  await sortTo("Added ↑");
  await expect.poll(async () => (await stems()).map((id) => byStem[id])).toEqual(members.map((m) => m.stem));
  // …and does not leak into the library: leaving the folder falls back to the default order.
  await ctx.window.getByRole("button", { name: "All Assets" }).click();
  await ctx.window.getByRole("button", { name: /^Imported/ }).first().click();
  await expect(ctx.window.getByRole("button", { name: "Added ↑", exact: true })).toHaveCount(0);
  await ctx.window.keyboard.press("Escape");
  await ctx.window.getByRole("button", { name: /^Filter me/ }).click();
});

test("a refined folder can be saved as a smart collection that follows the folder", async () => {
  await ctx.window.getByTitle("Rating ≥ 3").click();
  // Ask the catalog, then wait for the grid to agree (the click only starts the reload).
  const shown = await ctx.window.evaluate(() => window.mediaWorkspace.listCollections()
    .then((rows) => window.mediaWorkspace.browseCollection(rows.find((r) => r.name === "Filter me").collection_id, { filters: { rating_min: 3 }, limit: 100 }))
    .then((rows) => rows.length));
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(4);
  await expect(cards()).toHaveCount(shown);
  await ctx.window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = ctx.window.locator("[data-smart-name-input] input");
  await nameInput.fill("Best of Filter me");
  await nameInput.press("Enter");
  const row = ctx.window.locator("[data-smart-collection]").filter({ hasText: "Best of Filter me" });
  await expect(row).toHaveClass(/bg-selected/);
  await expect(cards()).toHaveCount(shown);
  const saved = await ctx.window.evaluate(() => window.mediaWorkspace.listCollections().then((rows) => rows.find((r) => r.name === "Best of Filter me")));
  const folder = await ctx.window.evaluate(() => window.mediaWorkspace.listCollections().then((rows) => rows.find((r) => r.name === "Filter me")));
  expect(saved.rules.filters).toEqual({ rating_min: 3, in_collection: folder.collection_id });
  expect(saved.item_count).toBe(shown);
  // It follows the folder: a rated photo added to the folder joins it.
  const outsider = await ctx.window.evaluate(async (memberIds) => {
    const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 100 });
    const pick = rows.find((r) => !memberIds.includes(r.asset_id) && r.asset_type !== "video" && r.stem !== "B0016108");
    await window.mediaWorkspace.setAssetRating([pick.asset_id], 5);
    return pick.asset_id;
  }, members.map((m) => m.id));
  await ctx.window.evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folder.collection_id, asset: outsider });
  await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.listCollections()
    .then((rows) => rows.find((r) => r.name === "Best of Filter me").item_count))).toBe(shown + 1);
  await ctx.window.evaluate(({ id, asset }) => window.mediaWorkspace.collectionRemoveItems(id, [asset]), { id: folder.collection_id, asset: outsider });
  await ctx.window.getByRole("button", { name: /^Filter me/ }).click();
  await expect(cards()).toHaveCount(4);
});

// The options are asked for after every change of view; on a slow machine
// they can still be on their way when the dropdown opens.
const facetsSettled = () => expect(ctx.window.locator("[data-filter-bar]")).toHaveAttribute("data-facets-ready", "true");

// Camera → count, as the open Camera dropdown shows it.
async function cameraCounts() {
  await facetsSettled();
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

// Option → count, as an open dropdown in the filter bar shows it.
async function facetCounts(label) {
  await facetsSettled();
  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: label, exact: true }).click();
  const options = ctx.window.locator("[data-facet-option]");
  await expect(options.first()).toBeVisible();
  const counts = await options.evaluateAll((els) => Object.fromEntries(els.map((el) => [el.dataset.facetOption, Number(el.dataset.facetCount)])));
  await ctx.window.keyboard.press("Escape");
  return counts;
}
const browseLength = (filters) => ctx.window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);

test("counts follow the other active filters: what picking an option would show", async () => {
  // Library view, nothing filtered: the fixture is JPGs plus one MP4.
  await ctx.window.getByRole("button", { name: "All Assets" }).click();
  const unfiltered = await facetCounts("Format");
  expect(unfiltered.MP4).toBe(1);
  expect(unfiltered.JPG).toBe(await browseLength({ extension: "jpg" }));

  // A rating no video has: MP4 would show nothing, so it is no longer offered,
  // and JPG counts only the rated JPGs.
  await ctx.window.getByTitle("Rating ≥ 3").click();
  const rated = await facetCounts("Format");
  expect(rated.MP4).toBeUndefined();
  expect(rated.JPG).toBe(await browseLength({ rating_min: 3, extension: "jpg" }));
  expect(rated.JPG).toBeLessThan(unfiltered.JPG);
  // Every count is exactly what choosing that option shows.
  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "Format", exact: true }).click();
  await ctx.window.locator('[data-facet-option="JPG"]').click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(rated.JPG);
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});

test("a selected option that nothing matches any more stays listed at 0, and the facet can still be switched", async () => {
  // The reported case: a format is selected, other filters leave it empty, and
  // the dropdown kept quoting the library's total beside it.
  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "Format", exact: true }).click();
  await ctx.window.locator('[data-facet-option="MP4"]').click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(1);
  await ctx.window.getByTitle("Rating ≥ 3").click();
  await expect(cards()).toHaveCount(0);

  const counts = await facetCounts("MP4"); // the chip now reads its selected value
  expect(counts.MP4).toBe(0);
  // Its own selection does not count against the alternatives: JPG still says
  // how many rated JPGs there are, so the user can switch to it.
  expect(counts.JPG).toBe(await browseLength({ rating_min: 3, extension: "jpg" }));
  expect(counts.JPG).toBeGreaterThan(0);

  await ctx.window.locator("[data-filter-bar]").getByRole("button", { name: "MP4", exact: true }).click();
  await ctx.window.locator('[data-facet-option="JPG"]').click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(counts.JPG);
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});
