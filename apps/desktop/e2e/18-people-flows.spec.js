// People-recognition flows against the pre-baked people fixture catalog
// (AI-generated fictional people; faces/embeddings/groups seeded offline by
// fixtures/seed-people-catalog.js — no Core ML model needed at runtime).
//
// Fixture layout: "Lin Xi" named (5 faces), one unnamed candidate (4 faces),
// plus one singleton face (third person on the group photo) that belongs to
// no group.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "people-flows", catalogFixture: "people" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

async function openPeoplePage() {
  await ctx.window.getByRole("navigation").getByRole("button", { name: "People" }).click();
  await expect(ctx.window.getByRole("heading", { name: "People" })).toBeVisible();
}

test("people wall shows the named person and the candidate with face covers", async () => {
  await openPeoplePage();

  await expect(ctx.window.getByRole("button", { name: "Lin Xi", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(ctx.window.getByText("5 faces")).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "Add name", exact: true })).toBeVisible();
  await expect(ctx.window.getByText("4 faces")).toBeVisible();

  // Covers are real face crops, not placeholder icons: every tile's FaceCrop
  // must have a loaded <img>.
  const tiles = ctx.window.locator("main .grid > div");
  await expect(tiles).toHaveCount(2);
  for (const tile of await tiles.all()) {
    const img = tile.locator("img").first();
    await expect(img).toBeVisible();
    expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }
});

test("naming the candidate suggests the existing person, then names it", async () => {
  await openPeoplePage();

  await ctx.window.getByRole("button", { name: "Add name", exact: true }).click();
  const popover = ctx.window.locator("div.fixed").filter({ has: ctx.window.getByPlaceholder("Type a name…") });
  await expect(popover).toBeVisible();
  // Similarity suggestions surface the existing named person before typing.
  await expect(popover.getByText("Lin Xi")).toBeVisible();

  await popover.getByPlaceholder("Type a name…").fill("Chen Mo");
  await popover.getByRole("button", { name: "Name", exact: true }).click();

  // Tile label flips in place (no resort) and the wall now has two named people.
  await expect(ctx.window.getByRole("button", { name: "Chen Mo", exact: true })).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "Add name", exact: true })).toHaveCount(0);
});

test("view photos filters the gallery to that person", async () => {
  // Regression: a search left behind in the asset gallery used to survive the
  // jump and intersect with the person filter, producing an empty result.
  await ctx.window.getByRole("navigation").getByRole("button", { name: "All Assets" }).click();
  await ctx.window.getByPlaceholder("Search").fill("definitely-no-such-photo");
  await openPeoplePage();

  await ctx.window.getByRole("button", { name: "Open Lin Xi in the library" }).click();
  await ctx.window.getByRole("button", { name: "View photos" }).click();

  // Toolbar title + person chip active, and the gallery shrinks to her photos
  // (portrait + 3 solos + 1 group photo = 5 of the 8 fixture images).
  await expect(ctx.window.getByText("Lin Xi").first()).toBeVisible();
  await expect(ctx.window.locator("[data-gallery-item='true']")).toHaveCount(5, { timeout: 10_000 });

  // Clearing the chip restores the full gallery.
  await ctx.window.getByRole("button", { name: /Clear 1/ }).click();
  await expect(ctx.window.locator("[data-gallery-item='true']")).toHaveCount(8, { timeout: 10_000 });

  // The sidebar reset is a separate route. Its slower summary refresh must
  // not later overwrite the gallery with the stale person query.
  await openPeoplePage();
  // The people wall intentionally preserves its prior selection when revisited,
  // so Lin Xi's inspector is already open here.
  await ctx.window.getByRole("button", { name: "View photos" }).click();
  await expect(ctx.window.locator("[data-gallery-item='true']")).toHaveCount(5, { timeout: 10_000 });
  await ctx.window.getByRole("navigation").getByRole("button", { name: "All Assets" }).click();
  await expect(ctx.window.locator("[data-gallery-item='true']")).toHaveCount(8, { timeout: 10_000 });
});

test("the resident person filter in the gallery filter bar works", async () => {
  // Still in the assets view from the previous test, filter bar visible.
  await ctx.window.locator("div.flex-wrap").getByRole("button", { name: /^Person$/ }).click();
  await ctx.window.locator("div.fixed").getByRole("button", { name: /Chen Mo/ }).click();
  await expect(ctx.window.locator("[data-gallery-item='true']")).toHaveCount(4, { timeout: 10_000 });
  await ctx.window.getByRole("button", { name: /Clear 1/ }).click();
});

test("batch-removing faces from a group updates the count", async () => {
  await openPeoplePage();

  await ctx.window.getByRole("button", { name: "Open Chen Mo in the library" }).click();
  await expect(ctx.window.getByText("Faces in this group", { exact: false })).toBeVisible();

  // Select two sample faces → the batch bar appears → remove them.
  const faceTiles = ctx.window.locator("aside .grid button");
  await expect(faceTiles.first()).toBeVisible({ timeout: 10_000 });
  await faceTiles.nth(0).click();
  await faceTiles.nth(1).click();
  await expect(ctx.window.getByText("2 faces selected").first()).toBeVisible();
  await ctx.window.getByRole("button", { name: "Remove", exact: true }).click();

  // Count drops from 4 to 2 in the panel and on the wall tile.
  await expect(ctx.window.getByText("Removed 2 faces")).toBeVisible({ timeout: 10_000 });
  await expect(ctx.window.locator("aside").getByText("2 faces", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("a chosen cover falls back when its face is removed", async () => {
  const faceTiles = ctx.window.locator("aside .grid button");
  const nonCover = faceTiles.filter({ hasNot: ctx.window.getByTitle("Current cover photo") }).first();
  const chosenFaceId = await nonCover.getAttribute("data-face-id");
  const chosen = ctx.window.locator(`[data-face-id="${chosenFaceId}"]`);
  await nonCover.click({ button: "right" });
  await ctx.window.getByRole("button", { name: "Set as cover photo" }).click();
  await expect(ctx.window.getByText("Person cover updated", { exact: true })).toBeVisible();
  await expect(chosen.getByTitle("Current cover photo")).toBeVisible();

  await chosen.click();
  await ctx.window.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(ctx.window.getByText("Removed 1 face", { exact: true })).toBeVisible();
  await expect(faceTiles).toHaveCount(1);
  await expect(faceTiles.first().getByTitle("Current cover photo")).toBeVisible();
});

test("command-click selection can delete multiple person groups from the context menu", async () => {
  await openPeoplePage();

  const linXi = ctx.window.getByRole("button", { name: "Open Lin Xi in the library" });
  const chenMo = ctx.window.getByRole("button", { name: "Open Chen Mo in the library" });
  await linXi.click();
  await chenMo.click({ modifiers: ["Meta"] });
  await expect(ctx.window.getByText("2 groups selected", { exact: true })).toBeVisible();

  await linXi.click({ button: "right" });
  await ctx.window.getByRole("button", { name: "Delete 2 selected groups" }).click();
  await ctx.window.getByRole("button", { name: "Delete 2 groups" }).click();

  await expect(ctx.window.getByRole("button", { name: "Lin Xi", exact: true })).toHaveCount(0);
  await expect(ctx.window.getByRole("button", { name: "Chen Mo", exact: true })).toHaveCount(0);
});
