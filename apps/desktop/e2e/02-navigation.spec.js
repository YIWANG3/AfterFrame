// Smoke test 2 — Sidebar navigation works between views.
// Doesn't depend on having a catalog loaded; just verifies the nav buttons
// react and the right pane swaps content.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Sidebar navigation", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "nav" }));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("can switch to Stickers view", async () => {
    const stickersBtn = window.getByRole("button", { name: /Stickers/i }).first();
    await expect(stickersBtn).toBeVisible({ timeout: 10_000 });
    await stickersBtn.click();
    // StickerView actually rendered: the seeded library is empty, so its
    // empty state is the anchor (the old assertion matched the nav button
    // itself and passed without the view mounting).
    await expect(window.getByText(/No stickers yet/i)).toBeVisible({ timeout: 5_000 });
  });

  test("can switch back to All Assets", async () => {
    const allAssetsBtn = window.getByRole("button", { name: /All Assets/i }).first();
    await expect(allAssetsBtn).toBeVisible();
    await allAssetsBtn.click();
    // Back in the asset gallery: seeded cards are visible again
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 5_000 });
  });

  test("Recently Added and Rated filters load real data", async () => {
    const recent = window.getByRole("button", { name: /Recently Added/i }).first();
    await expect(recent).toBeVisible();
    await recent.click();
    // Filter applied + real data loaded: the gallery shows items (more robust
    // than matching the duplicated "Recently Added" label by index, which raced
    // the toolbar title's render).
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 10_000 });

    // Four rated assets exist, so the Rated entry renders (gated on
    // rated_count > 0) and filters down to exactly them: two synthetic
    // images seeded at 4 stars, plus two real photographs whose original
    // XMP carries an embedded 5-star rating that import reads through.
    const rated = window.getByRole("button", { name: /Rated/i }).first();
    await expect(rated).toBeVisible();
    await rated.click();
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(4, { timeout: 5_000 });

    // restore
    await window.getByRole("button", { name: /All Assets/i }).first().click();
  });
});
