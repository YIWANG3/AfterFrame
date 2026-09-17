// The Discover view (coverage report B7): 02-navigation only switched to it
// and back. Against the seeded catalog it shows Memories as month groups
// (no sidecar memories yet, so DiscoverView falls back to grouping capture
// dates), the Rated pin (the only pin with a cover here), and an Album
// once a collection has items. Places need PLACE_MIN_PHOTOS (5) per place
// and the fixture has one photo per place, so that section must stay
// hidden. Every tile opens a filtered gallery through App.openDiscoverTarget.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const sectionNav = () => ctx.window.getByRole("navigation", { name: "Discover sections" });

async function openDiscover() {
  await ctx.window.getByRole("navigation").first().getByRole("button", { name: "Discover" }).click();
  await expect(sectionNav()).toBeVisible({ timeout: 10_000 });
}

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "discover" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("Discover groups the catalog by capture month and pins Rated; sparse sections stay hidden", async () => {
  await openDiscover();
  await expect(sectionNav().getByRole("button", { name: "Memories" })).toBeVisible();
  await expect(sectionNav().getByRole("button", { name: "Pinned" })).toBeVisible();
  // One photo per place is below PLACE_MIN_PHOTOS; no people, no albums yet.
  await expect(sectionNav().getByRole("button", { name: "Places" })).toHaveCount(0);
  await expect(sectionNav().getByRole("button", { name: "People" })).toHaveCount(0);
  await expect(sectionNav().getByRole("button", { name: "Albums" })).toHaveCount(0);

  // The three real photographs carry capture dates; the gradients do not.
  for (const month of ["February 2018", "May 2025", "October 2025"]) {
    await expect(ctx.window.getByRole("button", { name: new RegExp(`^${month}`) })).toBeVisible();
  }
  await expect(ctx.window.getByRole("button", { name: /^October 2025/ })).toContainText("1 items");
  await expect(ctx.window.getByRole("button", { name: "Rated", exact: true })).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "With RAW", exact: true })).toHaveCount(0);
});

test("the section nav jumps and marks the current section", async () => {
  await openDiscover();
  await sectionNav().getByRole("button", { name: "Pinned" }).click();
  await expect(sectionNav().getByRole("button", { name: "Pinned" })).toHaveAttribute("aria-current", "location");
  await sectionNav().getByRole("button", { name: "Memories" }).click();
  await expect(sectionNav().getByRole("button", { name: "Memories" })).toHaveAttribute("aria-current", "location");
});

test("opening a month filters the gallery to that month", async () => {
  await openDiscover();
  await ctx.window.getByRole("button", { name: /^October 2025/ }).click();
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  const captured = await cards().first().evaluate((el) => el.getAttribute("data-image-path"));
  expect(captured).toMatch(/\.(jpg|jpeg)$/i);
  // The date filter is active: the filters bar is shown for the date range.
  const rows = await ctx.window.evaluate(async () => (await window.mediaWorkspace.browseImages({ status: "all", limit: 100, filters: { date_from: "2025-10-01", date_to: "2025-10-31" } })).length);
  expect(rows).toBe(1);
  // Switching scope keeps facet filters by design; the Rated pin below opens
  // with empty filters, which is what clears the date range again.
});

test("the Rated pin opens the Rated scope", async () => {
  await openDiscover();
  await ctx.window.getByRole("button", { name: "Rated", exact: true }).click();
  await expect(cards()).toHaveCount(4, { timeout: 10_000 });
  await ctx.window.getByRole("button", { name: /^All Assets/ }).click();
  await expect(cards()).toHaveCount(14, { timeout: 10_000 });
});

test("an album with items appears under Albums and opens the folder", async () => {
  const created = await callTool("manage_collections", { action: "create", name: "Trip" });
  const collectionId = created.collection_id || created.id;
  expect(collectionId).toBeTruthy();
  const { assets } = await callTool("search_assets", { limit: 1, sort: "name-asc" });
  await callTool("manage_collections", { action: "add_items", collection_id: collectionId, asset_ids: [assets[0].asset_id] });

  await openDiscover();
  await expect(sectionNav().getByRole("button", { name: "Albums" })).toBeVisible({ timeout: 10_000 });
  const album = ctx.window.getByRole("button", { name: /^Trip/ });
  await expect(album).toBeVisible();
  await expect(album).toContainText(/Trip.*1/);
  await album.click();
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  await expect(cards().first()).toHaveAttribute("data-asset-id", assets[0].asset_id);
});
