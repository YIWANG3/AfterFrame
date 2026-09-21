// Location source ("no location" included) and the single-field "contains"
// filters, through the real filter bar. Expected numbers come from the catalog.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const bar = () => ctx.window.locator("[data-filter-bar]");
const browseLength = (filters) => ctx.window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);
const option = (value) => ctx.window.locator(`[data-facet-option="${value}"]`);

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "location-text-filters" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("location: GPS, none, or either — with counts that add up to the library", async () => {
  const total = await browseLength({});
  const withGps = await browseLength({ location_source: "exif" });
  const none = await browseLength({ location_source: "none" });
  expect(withGps).toBeGreaterThan(0);
  expect(none).toBeGreaterThan(0);

  await bar().getByRole("button", { name: "Location", exact: true }).click();
  // Options carry human labels, not the stored codes.
  await expect(option("none")).toContainText("No location");
  await expect(option("none")).toHaveAttribute("data-facet-count", String(none));
  await expect(option("exif")).toHaveAttribute("data-facet-count", String(withGps));
  await option("none").click();
  await expect(cards()).toHaveCount(none);
  await option("exif").click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(withGps + none);
  expect(withGps + none).toBeLessThanOrEqual(total);
  await expect(bar().getByRole("button", { name: "No location +1" })).toBeVisible();
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});

test("path contains narrows by folder, and is one field only", async () => {
  const inFolder = await browseLength({ path_contains: "real-images" });
  expect(inFolder).toBeGreaterThan(0);
  expect(inFolder).toBeLessThan(await browseLength({}));

  await bar().getByRole("button", { name: "Text", exact: true }).click();
  await ctx.window.locator("[data-text-facet='path_contains']").fill("real-images");
  await expect(cards()).toHaveCount(inFolder); // commits after a pause, no Enter needed
  await ctx.window.keyboard.press("Escape");
  await expect(bar().getByRole("button", { name: "real-images", exact: true })).toBeVisible();
  // The same words in the DESCRIPTION field match nothing: each box is its own field.
  await bar().getByRole("button", { name: "real-images", exact: true }).click();
  await ctx.window.locator("[data-text-facet='path_contains']").fill("");
  await ctx.window.locator("[data-text-facet='caption_contains']").fill("real-images");
  await expect(cards()).toHaveCount(0);
  await ctx.window.keyboard.press("Escape");
  // Clear empties the boxes too.
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
  await expect(cards()).toHaveCount(await browseLength({}));
  await bar().getByRole("button", { name: "Text", exact: true }).click();
  await expect(ctx.window.locator("[data-text-facet='caption_contains']")).toHaveValue("");
  await ctx.window.keyboard.press("Escape");
});

test("'no location' saves as a smart collection: the photos that still need a place", async () => {
  await bar().getByRole("button", { name: "Location", exact: true }).click();
  await option("none").click();
  await ctx.window.keyboard.press("Escape");
  await ctx.window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = ctx.window.locator("[data-smart-name-input] input");
  await nameInput.fill("Needs a place");
  await nameInput.press("Enter");
  const row = ctx.window.locator("[data-smart-collection]").filter({ hasText: "Needs a place" });
  await expect(row).toHaveClass(/bg-selected/);
  const saved = await ctx.window.evaluate(() => window.mediaWorkspace.listCollections().then((rows) => rows.find((r) => r.name === "Needs a place")));
  expect(saved.rules.filters).toEqual({ location_source: "none" });
  expect(saved.item_count).toBe(await browseLength({ location_source: "none" }));
});

test("an agent can ask for the same things", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  expect((await tool("search_assets", { location_source: "none", limit: 100 })).count).toBe(await browseLength({ location_source: "none" }));
  expect((await tool("search_assets", { path_contains: "real-images", limit: 100 })).count).toBe(await browseLength({ path_contains: "real-images" }));
});
