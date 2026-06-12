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

  test("Recently Added filter loads; Rated hidden when nothing is rated", async () => {
    const recent = window.getByRole("button", { name: /Recently Added/i }).first();
    await expect(recent).toBeVisible();
    await recent.click();
    // The toolbar title reflects the active filter
    await expect(window.getByText("Recently Added").nth(1)).toBeVisible({ timeout: 5_000 });
    // Seeded catalog has zero ratings — the Rated entry must NOT render
    // (rated_count gate). The old test silently no-op'd here.
    await expect(window.getByRole("button", { name: /^Rated$/i })).toHaveCount(0);
    // restore
    await window.getByRole("button", { name: /All Assets/i }).first().click();
  });
});
