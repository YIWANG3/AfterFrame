// Smart collections (docs/next-features-plan.md §D): a saved filter with a
// live count. Driven through the real filter bar and sidebar; the counts are
// checked against the bridge's own browse so the test does not hard-code what
// the seeded fixture happens to contain.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, mcpCall } = require("./helpers/app");

let app, window, userDataDir, mcpPort;

const browseCount = (filters) => window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);
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
  if (process.env.AF_SHOT) await window.screenshot({ path: process.env.AF_SHOT });

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
  // Saved and unchanged: neither "Update" nor a second save is offered.
  await expect(window.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Save as smart collection" })).toHaveCount(0);
});

test("the count follows the library: rating another photo adds it", async () => {
  const before = await rowCount("Five stars");
  // Leave the smart collection's view: the library entry alone keeps the
  // filters (as it always has), so clear them too.
  await window.getByRole("button", { name: "All Assets" }).click();
  await window.getByRole("button", { name: /^Clear/ }).click();
  // A photo that is not five stars yet.
  const target = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })
    .then((rows) => rows.find((row) => (row.app_rating || 0) < 5)?.asset_id));
  await window.locator(`[data-asset-id='${target}']`).click();
  await window.keyboard.press("5");
  await expect.poll(() => rowCount("Five stars")).toBe(before + 1);
});

test("opening it shows exactly its photos, with its conditions in the filter bar", async () => {
  await smartRow("Five stars").click();
  const expected = await browseCount({ rating_min: 5 });
  await expect(window.locator("[data-gallery-item='true']")).toHaveCount(expected);
  // The library entry is no longer the highlighted destination; the smart row is.
  await expect(smartRow("Five stars")).toHaveClass(/bg-selected/);
  await expect(window.getByRole("button", { name: "All Assets" })).not.toHaveClass(/bg-selected/);
});

test("changing a condition offers Update, which rewrites the saved filter", async () => {
  await window.getByTitle("Rating ≥ 4").click();
  await expect(window.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "Save as new" })).toBeVisible();
  await window.getByRole("button", { name: "Update", exact: true }).click();
  await expect(window.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect.poll(() => rowCount("Five stars")).toBe(await browseCount({ rating_min: 4 }));
  const stored = await window.evaluate(() => window.mediaWorkspace.listCollections()
    .then((rows) => rows.find((row) => row.name === "Five stars").rules));
  expect(stored).toMatchObject({ version: 1, status: "all", filters: { rating_min: 4 } });
});

test("last N days is saved as a relative condition", async () => {
  await window.getByRole("button", { name: "All Assets" }).click();
  await window.getByRole("button", { name: /^Clear/ }).click();
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

test("a snapshot freezes the current photos into an ordinary folder", async () => {
  const expected = await browseCount({ rating_min: 4 });
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
