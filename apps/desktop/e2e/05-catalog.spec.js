// Catalog-backed tests — uses the seeded fixture catalog (10 synthetic
// gradients + 3 real downscaled photographs).
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

  test("gallery shows the 13 seeded images", async () => {
    // Wait for any gallery item to render — uses the data attribute set on
    // each card. If sidecar / browse-exports / Gallery rendering is broken,
    // this fails fast.
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
    const count = await window.locator("[data-gallery-item='true']").count();
    // 10 synthetic gradients + 3 real photographs (see seed-catalog.js).
    expect(count).toBe(13);
  });

  test("filenames render in caption", async () => {
    // Synthetic fixtures are named 001-red.jpg through 010-black.jpg.
    // .first() because the inspector panel echoes the filename (caption +
    // heading + reveal-in-Finder path) for the active card.
    await expect(window.getByText(/001-red\.jpg/i).first()).toBeVisible();
    await expect(window.getByText(/010-black\.jpg/i).first()).toBeVisible();
    // Real photographs decode + render through the same preview pipeline.
    await expect(window.getByText(/B0016108\.jpg/i).first()).toBeVisible();
  });

  test("single-click selects a card; selection ring appears on inner box", async () => {
    const firstCard = window.locator("[data-gallery-item='true']").first();
    await firstCard.click();
    // The selection ring is on an inner div (not the button itself).
    await expect(firstCard).toHaveAttribute("data-selected", "true");
  });
});
