// Dominant colours: the catch-up job fills them on open for a catalog that
// predates them, the Inspector shows the palette, and the Colour filter
// takes any colour.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const bar = () => ctx.window.locator("[data-filter-bar]");
const browseLength = (filters) => ctx.window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "color-filter" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  // The seeded catalog has previews but no colours: a job fills them.
  await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getFacetValues({ status: "all" }).then((f) => f.colors_analyzed)), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(13);
  await ctx.window.getByRole("button", { name: "Filters" }).click();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a gradient photo is found by its own colour, and not by a far one", async () => {
  // 007-purple is painted around rgb(140, 80, 190).
  expect(await browseLength({ color: "#8c50be", color_tolerance: "strict" })).toBeGreaterThanOrEqual(1);
  const purple = await ctx.window.evaluate(
    () => window.mediaWorkspace.browseImages({ status: "all", filters: { color: "#8c50be", color_tolerance: "strict" }, limit: 1000 }).then((rows) => rows.map((r) => r.stem)),
  );
  expect(purple).toContain("007-purple");
  expect(purple).not.toContain("004-green");
  expect(await browseLength({ color: "#00ff00", color_tolerance: "strict" })).toBe(0);
});

test("pick a preset, type a hex, widen the tolerance", async () => {
  await bar().getByRole("button", { name: "Colour", exact: true }).click();
  await ctx.window.locator("[data-color-option='#5e35b1']").click(); // a preset purple
  await expect(cards()).toHaveCount(await browseLength({ color: "#5e35b1" }));
  await ctx.window.locator("[data-color-hex-input]").fill("8c50be");
  await ctx.window.locator("[data-color-hex-input]").press("Enter");
  await expect(cards()).toHaveCount(await browseLength({ color: ["#5e35b1", "#8c50be"] }));
  await ctx.window.locator("[data-color-tolerance]").getByRole("button", { name: "Loose" }).click();
  await expect(cards()).toHaveCount(await browseLength({ color: ["#5e35b1", "#8c50be"], color_tolerance: "loose" }));
  await ctx.window.keyboard.press("Escape");
  await bar().getByRole("button", { name: /^Clear/ }).click();
  await expect(cards()).toHaveCount(await browseLength({}));
});

test("the Inspector shows the palette; a swatch is a filter", async () => {
  await cards().filter({ hasText: "006-blue" }).first().click();
  const strip = ctx.window.locator("[data-testid='inspector-palette']");
  await expect(strip).toBeVisible();
  const swatches = strip.locator("[data-swatch]");
  expect(await swatches.count()).toBeGreaterThanOrEqual(1);
  const hex = await swatches.first().getAttribute("data-swatch");
  await swatches.first().click();
  // Both sides settle at their own pace (the grid re-browses, the catch-up
  // job's finish refresh may land in between): compare once both are there.
  await expect.poll(async () => (await cards().count()) === (await browseLength({ color: hex }))).toBe(true);
  expect(await browseLength({ color: hex })).toBeGreaterThanOrEqual(1);
  await expect(bar().getByRole("button", { name: /^Clear/ })).toBeVisible();
  await bar().getByRole("button", { name: /^Clear/ }).click();
});

test("Settings ▸ Library shows the count and can re-analyse everything", async () => {
  await ctx.window.keyboard.press("Meta+,");
  await ctx.window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Library" }).click();
  const row = ctx.window.getByText("Colour analysis", { exact: true }).locator("..");
  await expect(row).toContainText(/1[34] photos have a palette, 0 do not/);
  await expect(ctx.window.getByRole("button", { name: "Analyse missing" })).toBeDisabled();
  await ctx.window.getByRole("button", { name: "Re-analyse all" }).click();
  await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getColorsStatus()), { timeout: 30_000 })
    .toMatchObject({ running: false, missing: 0 });
  await ctx.window.keyboard.press("Escape");
});

test("an agent can search by colour, and reads the palette in get_asset", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  expect((await tool("search_assets", { color: "#8c50be", color_tolerance: "strict", limit: 100 })).count)
    .toBe(await browseLength({ color: "#8c50be", color_tolerance: "strict" }));
  const found = await tool("search_assets", { query: "006-blue", limit: 5 });
  const detail = await tool("get_asset", { asset_id: found.assets[0].asset_id });
  expect(detail.colors.length).toBeGreaterThanOrEqual(1);
  expect(detail.colors[0]).toMatchObject({ hex: expect.stringMatching(/^#[0-9a-f]{6}$/), share: expect.any(Number) });
});
