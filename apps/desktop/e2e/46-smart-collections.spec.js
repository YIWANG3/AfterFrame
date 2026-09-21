// Smart collections (docs/next-features-plan.md §D): a saved filter with a
// live count — and the two layers it lives in. WHERE the user is (a status
// view, a folder, a smart collection) defines the base set; the filter bar and
// search only refine inside it, and changing place clears them. Driven through
// the real filter bar and sidebar; counts are checked against the bridge's own
// browse so the test does not hard-code what the seeded fixture contains.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, mcpCall } = require("./helpers/app");

let app, window, userDataDir, mcpPort;

const browseCount = (filters) => window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);
// What a smart collection holds right now, asked of the catalog through its rules.
const collectionNamed = (name) => window.evaluate((n) => window.mediaWorkspace.listCollections().then((rows) => rows.find((row) => row.name === n)), name);
const holds = async (name) => {
  const { rules } = await collectionNamed(name);
  return window.evaluate((base) => window.mediaWorkspace.browseImages({ status: "all", base, limit: 1000 }).then((rows) => rows.length), rules);
};
const cards = () => window.locator("[data-gallery-item='true']");
const actions = () => window.locator("[data-filter-actions]");
const smartRow = (name) => window.locator("[data-smart-collection]").filter({ hasText: name });
const rowCount = async (name) => Number((await smartRow(name).locator("span.tabular-nums").innerText()).trim());

test.beforeAll(async () => {
  ({ app, window, userDataDir, mcpPort } = await launchApp({ testName: "smart-collections" }));
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (app) await closeApp(app, userDataDir);
});

test("nothing to save until there is a condition", async () => {
  await window.getByRole("button", { name: "Filters" }).click();
  await expect(window.getByRole("button", { name: "Save as smart collection" })).toHaveCount(0);
  await expect(window.locator("[data-smart-collections]")).toHaveCount(0);
});

test("Clear and the smart collection actions stay put while the facets scroll", async () => {
  // Narrow enough that the facets overflow their row.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
  await window.getByTitle("Rating ≥ 3").click();
  const scroller = window.locator("[data-filter-scroll]");
  const actions = window.locator("[data-filter-actions]");
  await expect(actions.getByRole("button", { name: /^Clear/ })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Save as smart collection" })).toBeVisible();
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // The right-edge fade says "more this way": on now, off at the end of the row.
  await expect(scroller).toHaveAttribute("data-more", "true");
  const before = await actions.boundingBox();
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(scroller).not.toHaveAttribute("data-more", "true");
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const after = await actions.boundingBox();
  expect(after.x).toBeCloseTo(before.x, 0);
  // Pinned at the bar's right edge, fully inside it, not under the scroller.
  const bar = await window.locator("[data-filter-bar]").boundingBox();
  const scrollBox = await scroller.boundingBox();
  expect(after.x + after.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
  expect(after.x).toBeGreaterThanOrEqual(scrollBox.x + scrollBox.width - 1);
  // The bar floats over the photos: the actions need a surface of their own,
  // like the facet chips, or they vanish against an image.
  // (Base colour only: whichever button the pointer rests on also has a hover gradient.)
  const surface = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  const chip = await surface(scroller.getByRole("button", { name: "Camera", exact: true }));
  expect(chip).not.toBe("rgba(0, 0, 0, 0)");
  expect(await surface(actions.getByRole("button", { name: /^Clear/ }))).toBe(chip);
  expect(await surface(actions.getByRole("button", { name: "Save as smart collection" }))).toBe(chip);
  if (process.env.AF_SHOT) {
    await window.evaluate(() => { document.documentElement.dataset.theme = "light"; document.querySelector("[data-testid='gallery-scroll']").scrollTop = 140; });
    await window.waitForTimeout(300);
    await window.screenshot({ path: process.env.AF_SHOT });
    await window.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.querySelector("[data-testid='gallery-scroll']").scrollTop = 0; });
  }

  await actions.getByRole("button", { name: /^Clear/ }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
});

test("saving the current filter creates a sidebar entry with the matching count", async () => {
  // Make sure at least one photo qualifies, whatever the fixture ships with.
  await window.locator("[data-gallery-item='true']").first().click();
  await window.keyboard.press("5");
  await window.getByTitle("Rating ≥ 5").click();
  await window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = window.locator("[data-smart-name-input] input");
  await nameInput.fill("Five stars");
  await nameInput.press("Enter");

  await expect(smartRow("Five stars")).toBeVisible();
  const expected = await browseCount({ rating_min: 5 });
  expect(expected).toBeGreaterThan(0);
  await expect.poll(() => rowCount("Five stars")).toBe(expected);
  // The new collection becomes the place: what was a refinement is now its
  // rules, so the filter bar is empty again and offers nothing to save.
  await expect(cards()).toHaveCount(expected);
  await expect(smartRow("Five stars")).toHaveClass(/bg-selected/);
  await expect(window.getByTestId("gallery-title")).toHaveText("Five stars");
  await expect(actions()).toHaveCount(0);
  // Clicking it right away used to empty the grid (same conditions, no reload).
  await smartRow("Five stars").click();
  await window.waitForTimeout(600);
  await expect(cards()).toHaveCount(expected);
});

test("changing place clears the refinement, and the count follows the library", async () => {
  const before = await rowCount("Five stars");
  // Refine inside the collection, then leave: the refinement stays behind.
  await window.getByTitle("Rating ≥ 5").click();
  await expect(actions().getByRole("button", { name: /^Clear/ })).toBeVisible();
  await window.getByRole("button", { name: "All Assets" }).click();
  await expect(actions()).toHaveCount(0);
  await expect(cards()).toHaveCount(await browseCount({}));
  // A photo that is not five stars yet.
  const target = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })
    .then((rows) => rows.find((row) => (row.app_rating || 0) < 5)?.asset_id));
  await window.locator(`[data-asset-id='${target}']`).click();
  await window.keyboard.press("5");
  await expect.poll(() => rowCount("Five stars")).toBe(before + 1);
});

test("inside a smart collection the filter bar starts empty and only narrows the view", async () => {
  await smartRow("Five stars").click();
  const all = await holds("Five stars");
  await expect(cards()).toHaveCount(all);
  await expect(smartRow("Five stars")).toHaveClass(/bg-selected/);
  await expect(window.getByRole("button", { name: "All Assets" })).not.toHaveClass(/bg-selected/);
  // Its own condition (five stars) is NOT shown as a filter: no Clear, nothing to save.
  await expect(actions()).toHaveCount(0);

  // Narrow to one camera: the grid shrinks, the collection itself does not change.
  const camera = "Canon EOS R6m2";
  await window.locator("[data-filter-bar]").getByRole("button", { name: "Camera", exact: true }).click();
  // Counted INSIDE the collection: only cameras with five-star photos are offered.
  const offered = await window.locator("[data-facet-option]").evaluateAll((els) => els.map((el) => el.dataset.facetOption));
  expect(offered).not.toContain("Canon EOS 6D"); // that photo is unrated
  await window.locator(`[data-facet-option="${camera}"]`).click();
  await window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(1);
  expect(await rowCount("Five stars")).toBe(all);
  expect((await collectionNamed("Five stars")).rules.filters).toEqual({ rating_min: 5 });

  // Clear goes back to the whole collection, not to the whole library.
  await actions().getByRole("button", { name: /^Clear/ }).click();
  await expect(cards()).toHaveCount(all);
  await expect(window.getByTestId("gallery-title")).toHaveText("Five stars");
});

test("a refinement can be saved as a new collection nested on this one, or narrow this one", async () => {
  const camera = "Canon EOS R6m2";
  await window.locator("[data-filter-bar]").getByRole("button", { name: "Camera", exact: true }).click();
  await window.locator(`[data-facet-option="${camera}"]`).click();
  await window.keyboard.press("Escape");
  await expect(actions().getByRole("button", { name: /Narrow “Five stars” to this/ })).toBeVisible();

  await actions().getByRole("button", { name: "Save as new" }).click();
  const nameInput = window.locator("[data-smart-name-input] input");
  await nameInput.fill("Five star Canon");
  await nameInput.press("Enter");
  await expect(smartRow("Five star Canon")).toHaveClass(/bg-selected/);
  // Nested, not merged: the original rules ride along untouched.
  const nested = (await collectionNamed("Five star Canon")).rules;
  expect(nested.filters).toEqual({ camera });
  expect(nested.base.filters).toEqual({ rating_min: 5 });
  await expect.poll(() => rowCount("Five star Canon")).toBe(1);
  await expect(cards()).toHaveCount(1);
  // The original is unchanged.
  expect((await collectionNamed("Five stars")).rules.filters).toEqual({ rating_min: 5 });
});

test("editing conditions is its own mode: the bar shows the rules, Save rewrites them, Cancel does not", async () => {
  await smartRow("Five stars").hover();
  await smartRow("Five stars").getByTitle("Edit conditions").click();
  await expect(window.locator("[data-smart-editing]")).toContainText("Five stars");
  const save = actions().getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled(); // nothing changed yet

  await window.getByTitle("Rating ≥ 4").click();
  await expect(save).toBeEnabled();
  await actions().getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await collectionNamed("Five stars")).rules.filters).toEqual({ rating_min: 5 });
  await expect(window.locator("[data-smart-editing]")).toHaveCount(0);

  await smartRow("Five stars").hover();
  await smartRow("Five stars").getByTitle("Edit conditions").click();
  await window.getByTitle("Rating ≥ 4").click();
  await save.click();
  await expect(window.locator("[data-smart-editing]")).toHaveCount(0);
  expect((await collectionNamed("Five stars")).rules).toMatchObject({ version: 1, status: "all", filters: { rating_min: 4 } });
  await expect.poll(() => rowCount("Five stars")).toBe(await browseCount({ rating_min: 4 }));
  // Back to viewing it: all of it, with an empty bar.
  await expect(cards()).toHaveCount(await browseCount({ rating_min: 4 }));
  await expect(actions()).toHaveCount(0);
  // The nested collection follows its base: it is still "Canon among Five stars".
  expect(await holds("Five star Canon")).toBe(await browseCount({ rating_min: 4, camera: "Canon EOS R6m2" }));
});

test("last N days is saved as a relative condition", async () => {
  await window.getByRole("button", { name: "All Assets" }).click();
  await window.getByRole("button", { name: "Date", exact: true }).click();
  await window.locator("[data-filter-within-days] button").filter({ hasText: "30d" }).click();
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = window.locator("[data-smart-name-input] input");
  await nameInput.fill("This month");
  await nameInput.press("Enter");
  await expect(smartRow("This month")).toBeVisible();
  const stored = await window.evaluate(() => window.mediaWorkspace.listCollections()
    .then((rows) => rows.find((row) => row.name === "This month").rules));
  expect(stored.filters).toEqual({ date_within_days: 30 });
  await expect.poll(() => rowCount("This month")).toBe(await browseCount({ date_within_days: 30 }));
});

test("narrowing rewrites the open collection to what is showing, on top of its old rules", async () => {
  // A status view is a condition by itself: "Rated", saved.
  await window.getByRole("button", { name: /^Rated\b/ }).first().click();
  await actions().getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = window.locator("[data-smart-name-input] input");
  await nameInput.fill("Rated ones");
  await nameInput.press("Enter");
  await expect(smartRow("Rated ones")).toHaveClass(/bg-selected/);
  expect((await collectionNamed("Rated ones")).rules).toMatchObject({ status: "rated", filters: {} });
  const before = await rowCount("Rated ones");
  await window.getByTitle("Rating ≥ 5").click();
  await actions().getByRole("button", { name: /Narrow “Rated ones” to this/ }).click();
  await expect(actions()).toHaveCount(0); // it is the collection's rules now, not a refinement
  const rules = (await collectionNamed("Rated ones")).rules;
  expect(rules.filters).toEqual({ rating_min: 5 });
  expect(rules.base).toMatchObject({ status: "rated" });
  const after = await browseCount({ rating_min: 5 });
  expect(after).toBeLessThan(before);
  await expect.poll(() => rowCount("Rated ones")).toBe(after);
  await expect(cards()).toHaveCount(after);
});

test("the sidebar's covers switch gives smart collections a cover too", async () => {
  await window.getByTitle("Show covers").click();
  const row = smartRow("Five stars");
  const cover = row.locator("[data-smart-cover]");
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((el) => el.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
  // The cover is the first photo the collection currently shows.
  const first = await window.evaluate((base) => window.mediaWorkspace.browseImages({ status: "all", base, limit: 1 })
    .then((rows) => rows[0].preview_path || rows[0].image_path), (await collectionNamed("Five stars")).rules);
  expect(decodeURIComponent(await cover.getAttribute("src"))).toContain(first.split("/").pop());
  // Covers mode shows the count as "N items" under the name, like a folder.
  await expect(row).toContainText(`${await holds("Five stars")} items`);
  // A collection with nothing in it keeps the placeholder tile.
  if ((await browseCount({ date_within_days: 30 })) === 0) {
    await expect(smartRow("This month").locator("[data-smart-cover]")).toHaveCount(0);
  }
  await window.getByTitle("Show as list").click();
  await expect(cover).toHaveCount(0);
});

test("a snapshot freezes the current photos into an ordinary folder", async () => {
  const expected = await holds("Five stars");
  await smartRow("Five stars").hover();
  await smartRow("Five stars").getByTitle("Copy current photos to a folder").click();
  await expect.poll(() => window.evaluate(() => window.mediaWorkspace.listCollections()
    .then((rows) => rows.find((row) => row.name === "Five stars (snapshot)")?.item_count ?? null))).toBe(expected);
});

test("an agent can create, browse and re-condition a smart collection over MCP", async () => {
  const tool = async (name, args) => {
    const result = await mcpCall(mcpPort, "tools/call", { name, arguments: args });
    const text = result.content[0].text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const created = await tool("manage_collections", { action: "create", name: "Agent picks", rules: { rating_min: 5 } });
  expect(created.kind).toBe("smart");
  // The app's sidebar hears about it without a reload.
  await expect(smartRow("Agent picks")).toBeVisible();

  const browsed = await tool("manage_collections", { action: "browse", collection_id: created.collection_id, limit: 100 });
  const searched = await tool("search_assets", { rating_min: 5, limit: 100 });
  expect(browsed.count).toBeGreaterThan(0);
  expect(browsed.assets.map((a) => a.asset_id).sort()).toEqual(searched.assets.map((a) => a.asset_id).sort());

  await tool("manage_collections", { action: "update_rules", collection_id: created.collection_id, rules: { date_within_days: 30 } });
  const listed = (await tool("manage_collections", { action: "list" })).collections.find((c) => c.collection_id === created.collection_id);
  expect(listed.rules.filters).toEqual({ date_within_days: 30 });
  expect(listed.item_count).toBe((await tool("search_assets", { date_within_days: 30, limit: 100 })).count);

  // Misuse is answered plainly, not silently accepted.
  const noConditions = await tool("manage_collections", { action: "create", name: "Empty", rules: {} });
  expect(noConditions.error).toMatch(/at least one condition/);
  const added = await tool("manage_collections", { action: "add_items", collection_id: created.collection_id, asset_ids: [searched.assets[0].asset_id] });
  expect(added.error).toMatch(/fills itself/);
  await tool("manage_collections", { action: "delete", collection_id: created.collection_id });
  await expect(smartRow("Agent picks")).toHaveCount(0);
});

test("smart collections survive a restart, and photos cannot be added to one by hand", async () => {
  await collectCoverage(app); // the restart path bypasses closeApp
  await app.close();
  ({ app, window } = await launchApp({ testName: "smart-collections", reuseUserDataDir: userDataDir, keepCatalog: true }));
  await expect(smartRow("Five stars")).toBeVisible({ timeout: 15_000 });
  await expect(smartRow("This month")).toBeVisible();

  const error = await window.evaluate(async () => {
    const rows = await window.mediaWorkspace.listCollections();
    const smart = rows.find((row) => row.name === "Five stars");
    const asset = (await window.mediaWorkspace.browseImages({ status: "all", limit: 1 }))[0];
    try { await window.mediaWorkspace.collectionAddItems(smart.collection_id, [asset.asset_id]); return null; }
    catch (e) { return String(e?.message || e); }
  });
  expect(error).toMatch(/fills itself/);
});
