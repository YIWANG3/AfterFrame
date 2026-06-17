// First-run / no-catalog state. Packaged installs open no catalog by default;
// the app must guide the user to create/open one instead of silently failing.
// Simulated via AFTERFRAME_NO_DEFAULT_CATALOG (see helpers/app.js noCatalog).

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("First run (no catalog)", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "welcome", noCatalog: true }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("shows the welcome guide with create/open actions", async () => {
    await expect(window.getByText("Welcome to AfterFrame")).toBeVisible({ timeout: 10_000 });
    await expect(window.getByRole("button", { name: "New Catalog" })).toBeVisible();
    await expect(window.getByRole("button", { name: /Open Existing/ })).toBeVisible();
  });

  test("is inline — sidebar (and Settings) stay reachable", async () => {
    // The guide fills the gallery pane, NOT a full-screen overlay, so the
    // sidebar Settings button is still clickable (needed to change language
    // before any catalog exists).
    await expect(window.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  test("no gallery cards render without a catalog", async () => {
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(0);
  });
});
