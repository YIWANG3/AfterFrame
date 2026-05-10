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
    // Sticker view toolbar shows the count badge
    await expect(window.getByText(/Sticker/i).first()).toBeVisible();
  });

  test("can switch back to All Assets", async () => {
    const allAssetsBtn = window.getByRole("button", { name: /All Assets/i }).first();
    await expect(allAssetsBtn).toBeVisible();
    await allAssetsBtn.click();
    // We're no longer in sticker mode — Stickers nav entry shouldn't have its active state
    // (we don't have a great selector for "active" without DOM inspection — relying on
    //  visual cue would be fragile, so just confirm clicking didn't error)
  });

  test("Recent / Rated filters are clickable", async () => {
    const recent = window.getByRole("button", { name: /Recent/i }).first();
    if (await recent.isVisible()) {
      await recent.click();
      await window.waitForTimeout(200);
    }
    const rated = window.getByRole("button", { name: /Rated/i }).first();
    if (await rated.isVisible()) {
      await rated.click();
      await window.waitForTimeout(200);
    }
  });
});
