// First-run / no-catalog state. Packaged installs open no catalog by default;
// the app must guide the user to create/open one instead of silently failing.
// Simulated via AFTERFRAME_NO_DEFAULT_CATALOG (see helpers/app.js noCatalog).

const path = require("node:path");
const fs = require("node:fs");
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

  test("shows the welcome guide with create/open/sample actions", async () => {
    await expect(window.getByText("Welcome to AfterFrame")).toBeVisible({ timeout: 10_000 });
    await expect(window.getByRole("button", { name: "New Catalog" })).toBeVisible();
    await expect(window.getByRole("button", { name: /Open Existing/ })).toBeVisible();
    await expect(window.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
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

  // Runs last: it leaves the app inside the sample catalog.
  test("sample library: one click creates it, opens it, and shows the banner", async () => {
    await window.getByRole("button", { name: "Browse Sample Library" }).click();
    // Switching in shows the persistent sample banner with its two exits.
    await expect(window.getByText(/browsing the sample library/i)).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("button", { name: "Create My Library" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Reset Sample Library" })).toBeVisible();
    // The bundled photos import in the background and land in the gallery.
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 120_000 });
  });

  test("sample library: reset wipes and rebuilds it in place", async () => {
    // DOM alone can't prove the rebuild (item count is identical before and
    // after), so use the catalog DB file: reset deletes the folder and the
    // re-import creates a brand-new sqlite file with a later birthtime.
    const dbPath = path.join(userDataDir, "afterframe", "sample.afcatalog", "catalog.sqlite3");
    const before = fs.statSync(dbPath).birthtimeMs;

    await window.getByRole("button", { name: "Reset Sample Library" }).click();
    await window.getByRole("button", { name: "Reset", exact: true }).click();

    await expect
      .poll(() => (fs.existsSync(dbPath) ? fs.statSync(dbPath).birthtimeMs : 0), { timeout: 60_000 })
      .toBeGreaterThan(before);
    // Still inside the sample catalog; the demo photos re-import.
    await expect(window.getByText(/browsing the sample library/i)).toBeVisible({ timeout: 30_000 });
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 120_000 });
  });
});
