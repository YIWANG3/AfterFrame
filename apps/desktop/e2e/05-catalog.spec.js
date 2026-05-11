// Catalog-backed tests — uses the seeded 10-image fixture catalog.
// Verifies that the sidecar + IPC + Gallery rendering chain works end-to-end.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Catalog browse", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "catalog" }));
    // Wait for the initial gallery query to settle
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("gallery shows the 10 seeded images", async () => {
    // Wait for any gallery item to render — uses the data attribute set on
    // each card. If sidecar / browse-exports / Gallery rendering is broken,
    // this fails fast.
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
    const count = await window.locator("[data-gallery-item='true']").count();
    expect(count).toBe(10);
  });

  test("filenames render in caption", async () => {
    // Each fixture is named 001-red.jpg through 010-black.jpg
    await expect(window.getByText(/001-red\.jpg/i)).toBeVisible();
    await expect(window.getByText(/010-black\.jpg/i)).toBeVisible();
  });

  test("single-click selects a card; selection ring appears on inner box", async () => {
    const firstCard = window.locator("[data-gallery-item='true']").first();
    await firstCard.click();
    // The selection ring is on an inner div (not the button itself).
    await expect(firstCard.locator(".ring-accent").first()).toBeVisible();
  });
});
