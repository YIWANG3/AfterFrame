// Country and City filters. The seeded catalog predates them, so opening it
// runs the schema upgrade that names every location from its coordinates;
// the expected numbers come from the catalog, not from this file.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
let facets;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const bar = () => ctx.window.locator("[data-filter-bar]");
const browseLength = (filters) => ctx.window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);
const option = (value) => ctx.window.locator(`[data-facet-option="${value}"]`);

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "country-city-filters" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
  facets = await ctx.window.evaluate(() => window.mediaWorkspace.getFacetValues({ status: "all" }));
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("GPS photos got a country and a city from their coordinates", async () => {
  expect(facets.countries.length).toBeGreaterThan(0);
  expect(facets.cities.length).toBeGreaterThan(0);
  // Every located photo is in some country; options are named, not coded.
  const located = (await browseLength({})) - (await browseLength({ location_source: "none" }));
  expect(facets.countries.reduce((sum, c) => sum + c.count, 0)).toBeLessThanOrEqual(located);
  for (const country of facets.countries) {
    expect(country.value).toMatch(/^[A-Z]{2}$/);
    expect(country.label_en).not.toBe(country.value);
  }
});

test("pick a country, then a city inside it", async () => {
  const country = facets.countries[0];
  const inCountry = await browseLength({ country: country.value });
  expect(inCountry).toBe(country.count);

  await bar().getByRole("button", { name: "Country/Region", exact: true }).click();
  await expect(option(country.value)).toContainText(country.label_en);
  await expect(option(country.value)).toHaveAttribute("data-facet-count", String(inCountry));
  await option(country.value).click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(inCountry);
  await expect(bar().getByRole("button", { name: country.label_en, exact: true })).toBeVisible();

  // The city list now only offers cities of that country.
  const narrowed = await ctx.window.evaluate(
    (f) => window.mediaWorkspace.getFacetValues({ status: "all", filters: f }),
    { country: country.value },
  );
  expect(narrowed.cities.length).toBeGreaterThan(0);
  expect(narrowed.cities.every((c) => c.country === country.value)).toBe(true);
  const city = narrowed.cities[0];
  await bar().getByRole("button", { name: "City", exact: true }).click();
  await expect(option(city.value)).toHaveAttribute("data-facet-count", String(city.count));
  await option(city.value).click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(await browseLength({ country: country.value, city: city.value }));
  await bar().getByRole("button", { name: /^Clear/ }).click();
});

test("the city list searches by name", async () => {
  const city = facets.cities[0];
  await bar().getByRole("button", { name: "City", exact: true }).click();
  await ctx.window.getByPlaceholder(/City/).fill(String(city.value).slice(0, 4));
  await expect(option(city.value)).toBeVisible();
  await ctx.window.getByPlaceholder(/City/).fill("zzzz-nowhere");
  await expect(option(city.value)).toHaveCount(0);
  await ctx.window.keyboard.press("Escape");
});

test("an agent can ask by country and by city", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const country = facets.countries[0];
  const city = facets.cities[0];
  expect((await tool("search_assets", { country: country.value, limit: 1000 })).count).toBe(country.count);
  expect((await tool("search_assets", { city: [city.value], limit: 1000 })).count).toBe(city.count);
});
