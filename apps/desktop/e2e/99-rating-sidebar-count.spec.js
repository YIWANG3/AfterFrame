// A rating made in the app moves the sidebar's Rated count at once, with
// nothing clicked first: a number key on the selected photo, the Inspector's
// stars, a key on many photos at once, and clearing a rating (0). The Rated
// entry shows with the first rating and goes with the last. These writes send
// no catalog-changed (an agent's do), so the count used to wait for the next
// sidebar click or import.
// One app launch on the seeded catalog; the tests build on each other.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;

// The sidebar entry, "Rated" and its count; never a gallery title or menu item.
const ratedEntry = () => ctx.window.getByRole("button", { name: /^Rated\s*\d+$/ });
const ratedCount = (count) => new RegExp(`^Rated\\s*${count}$`);
const card = (assetId) => ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`);

async function rows(status) {
  return ctx.window.evaluate((s) => window.mediaWorkspace.browseImages({ status: s, limit: 500 }), status);
}

async function selectCard(assetId) {
  await card(assetId).scrollIntoViewIfNeeded();
  await card(assetId).click();
  await expect(card(assetId)).toHaveAttribute("data-selected", "true");
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "rating-sidebar-count" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a rating key and the Inspector's stars move the Rated count; clearing moves it back", async () => {
  const before = (await rows("rated")).length;
  expect(before, "the seeded catalog has rated photos").toBeGreaterThan(0);
  await expect(ratedEntry()).toHaveText(ratedCount(before));

  const [first, second] = (await rows("all")).filter((row) => !row.app_rating);
  await selectCard(first.asset_id);
  await ctx.window.keyboard.press("3");
  await expect(ratedEntry()).toHaveText(ratedCount(before + 1));

  await selectCard(second.asset_id);
  const stars = ctx.window.getByTestId("inspector-rating");
  await stars.getByRole("button").nth(1).click();
  await expect(stars).toHaveAttribute("data-value", "2");
  await expect(ratedEntry()).toHaveText(ratedCount(before + 2));

  // A new rating on a rated photo is no new photo in Rated.
  await ctx.window.keyboard.press("5");
  await expect(stars).toHaveAttribute("data-value", "5");
  await ctx.window.keyboard.press("0");
  await expect(ratedEntry()).toHaveText(ratedCount(before + 1));

  await selectCard(first.asset_id);
  await ctx.window.keyboard.press("0");
  await expect(ratedEntry()).toHaveText(ratedCount(before));
});

test("the Rated entry goes with the last rating and comes back with the first", async () => {
  // Every rated photo, cleared with one key: one write for all of them.
  await ratedEntry().click();
  await expect(ctx.window.getByTestId("gallery-title")).toHaveText("Rated");
  const cards = galleryCards(ctx.window);
  await expect(cards).toHaveCount((await rows("rated")).length, { timeout: 10_000 });
  await cards.first().click();
  await ctx.window.keyboard.press("ControlOrMeta+a");
  await expect(cards.last()).toHaveAttribute("data-selected", "true");
  await ctx.window.keyboard.press("0");
  await expect(ratedEntry()).toHaveCount(0);
  expect(await rows("rated")).toHaveLength(0);

  await ctx.window.getByRole("button", { name: /All Assets/i }).first().click();
  const [target] = await rows("all");
  await selectCard(target.asset_id);
  await ctx.window.keyboard.press("4");
  await expect(ratedEntry()).toHaveText(ratedCount(1));
});
