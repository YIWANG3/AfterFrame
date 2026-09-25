// Several values within one facet are OR; different facets are AND; tags can
// also require all of the picked ones. Driven through the real dropdowns, with
// every expected number asked of the catalog rather than hard-coded.

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
const optionCounts = async () => {
  // Options are re-asked after every change; read them once they are current.
  await expect(ctx.window.locator("[data-filter-bar]")).toHaveAttribute("data-facets-ready", "true");
  return ctx.window.locator("[data-facet-option]")
    .evaluateAll((els) => Object.fromEntries(els.map((el) => [el.dataset.facetOption, Number(el.dataset.facetCount)])));
};

const CANON = "Canon EOS R6m2";
const HASSELBLAD = "CFV 100C/907X";

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "filter-multiselect" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  // Three tagged photos: night+neon, night, neon.
  await ctx.window.evaluate(async () => {
    const bridge = window.mediaWorkspace;
    const rows = (await bridge.browseImages({ status: "all", limit: 100, sort: "name-asc" })).filter((r) => r.asset_type !== "video");
    const plan = [["night", "neon"], ["night"], ["neon"]];
    for (let i = 0; i < plan.length; i += 1) for (const tag of plan[i]) await bridge.addAssetTag(rows[i].asset_id, tag);
  });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("ticking two cameras shows photos from either, and the chip says how many are picked", async () => {
  await bar().getByRole("button", { name: "Camera", exact: true }).click();
  await option(CANON).click();
  await expect(cards()).toHaveCount(await browseLength({ camera: CANON }));
  // The popover stays open: tick the second one straight away.
  await option(HASSELBLAD).click();
  await expect(option(CANON)).toHaveAttribute("aria-checked", "true");
  await expect(option(HASSELBLAD)).toHaveAttribute("aria-checked", "true");
  await ctx.window.keyboard.press("Escape");

  const either = await browseLength({ camera: [CANON, HASSELBLAD] });
  expect(either).toBe((await browseLength({ camera: CANON })) + (await browseLength({ camera: HASSELBLAD })));
  await expect(cards()).toHaveCount(either);
  await expect(bar().getByRole("button", { name: `${CANON} +1` })).toBeVisible();
  // One facet, however many values, is one active filter.
  await expect(ctx.window.getByRole("button", { name: /^Clear 1$/ })).toBeVisible();
});

test("other facets still narrow it, and their counts are taken inside the picked cameras", async () => {
  await bar().getByRole("button", { name: "Format", exact: true }).click();
  const formats = await optionCounts();
  // Only the formats those two cameras have, with the numbers picking them would give.
  expect(formats.JPG).toBe(await browseLength({ camera: [CANON, HASSELBLAD], extension: "jpg" }));
  expect(formats.MP4).toBeUndefined();
  await ctx.window.keyboard.press("Escape");

  // The camera dropdown itself still offers the third camera, with ITS count.
  await bar().getByRole("button", { name: `${CANON} +1` }).click();
  const cameras = await optionCounts();
  expect(cameras["Canon EOS 6D"]).toBe(await browseLength({ camera: "Canon EOS 6D" }));
  // Unticking one goes back to a single value.
  await option(HASSELBLAD).click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(await browseLength({ camera: CANON }));
  await expect(bar().getByRole("button", { name: CANON, exact: true })).toBeVisible();
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});

test("tags: any of the picked ones by default, all of them on request", async () => {
  await bar().getByRole("button", { name: "Tag", exact: true }).click();
  await option("night").click();
  // One tag can be included or excluded; "all of these" needs a second.
  const allOfThese = ctx.window.locator("[data-facet-match]").getByRole("button", { name: "All of these" });
  await expect(ctx.window.locator("[data-facet-mode='exclude']")).toBeVisible();
  await expect(allOfThese).toHaveCount(0);
  await option("neon").click();
  await expect(allOfThese).toBeVisible();
  await expect(cards()).toHaveCount(3);

  await ctx.window.locator("[data-facet-match]").getByRole("button", { name: "All of these" }).click();
  await expect(cards()).toHaveCount(1);
  expect(await browseLength({ tag: ["night", "neon"], tag_match: "all" })).toBe(1);
  // Still one active filter: the switch tunes the tag filter, it is not another one.
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByRole("button", { name: /^Clear 1$/ })).toBeVisible();

  // Back to a single tag: "all" no longer means anything and is dropped.
  await bar().getByRole("button", { name: "night +1" }).click();
  await option("neon").click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(2);
});

test("a multi-value filter saves into a smart collection and comes back as one", async () => {
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
  await bar().getByRole("button", { name: "Camera", exact: true }).click();
  await option(CANON).click();
  await option(HASSELBLAD).click();
  await ctx.window.keyboard.press("Escape");
  await ctx.window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = ctx.window.locator("[data-smart-name-input] input");
  await nameInput.fill("Two cameras");
  await nameInput.press("Enter");
  const row = ctx.window.locator("[data-smart-collection]").filter({ hasText: "Two cameras" });
  await expect(row).toHaveClass(/bg-selected/);
  const saved = await ctx.window.evaluate(() => window.mediaWorkspace.listCollections().then((rows) => rows.find((r) => r.name === "Two cameras")));
  expect(saved.rules.filters.camera.sort()).toEqual([CANON, HASSELBLAD].sort());
  expect(saved.item_count).toBe(await browseLength({ camera: [CANON, HASSELBLAD] }));
  await expect(cards()).toHaveCount(saved.item_count);

  // Editing its conditions shows both cameras ticked.
  await row.hover();
  await row.getByTitle("Edit conditions").click();
  await bar().getByRole("button", { name: /\+1$/ }).click();
  await expect(option(CANON)).toHaveAttribute("aria-checked", "true");
  await expect(option(HASSELBLAD)).toHaveAttribute("aria-checked", "true");
  await ctx.window.keyboard.press("Escape");
});

test("an agent can pass a list too", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const either = await tool("search_assets", { camera: [CANON, HASSELBLAD], limit: 100 });
  expect(either.count).toBe(await browseLength({ camera: [CANON, HASSELBLAD] }));
  const one = await tool("search_assets", { camera: CANON, limit: 100 }); // a single string still works
  expect(one.count).toBe(await browseLength({ camera: CANON }));
  const both = await tool("search_assets", { tag: ["night", "neon"], tag_match: "all", limit: 100 });
  expect(both.count).toBe(1);
});
