// First-run / no-catalog state. Packaged installs open no catalog by default;
// the app must guide the user to create/open one instead of silently failing.
// Simulated via AFTERFRAME_NO_DEFAULT_CATALOG (see helpers/app.js noCatalog).

const path = require("node:path");
const fs = require("node:fs");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("First run (no catalog)", () => {
  let app, window, userDataDir;
  const mainLogs = [];

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "welcome", noCatalog: true }));
    app.process().stdout.on("data", (data) => mainLogs.push(String(data)));
    app.process().stderr.on("data", (data) => mainLogs.push(String(data)));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("electron-main.log", { body: mainLogs.join(""), contentType: "text/plain" });
    }
  });

  test("shows the welcome guide with create/open/sample actions", async () => {
    await expect(window.getByText("Welcome to AfterFrame")).toBeVisible({ timeout: 10_000 });
    await expect(window.getByRole("button", { name: "New Catalog" })).toBeVisible();
    await expect(window.getByRole("button", { name: /Open Existing/ })).toBeVisible();
    await expect(window.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
  });

  test("settings shortcut remains available before opening a catalog", async () => {
    await window.keyboard.press("Meta+,");
    await expect(window.getByRole("button", { name: "General", exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
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
    // Reset as soon as the first card appears; do NOT wait for the background
    // import to finish. This used to race ongoing writes and fail ENOTEMPTY.
    // A sentinel proves the old directory was wiped without relying on
    // filesystem birthtime precision or accepting stale pre-reset gallery cards.
    const dbPath = path.join(userDataDir, "afterframe", "sample.afcatalog", "catalog.sqlite3");
    const sentinel = path.join(path.dirname(dbPath), "reset-sentinel");
    fs.mkdirSync(sentinel);
    const previousJob = await window.evaluate(() => window.mediaWorkspace.getImportStatus());
    const logStart = mainLogs.length;

    await window.getByRole("button", { name: "Reset Sample Library" }).click();
    await window.getByRole("button", { name: "Reset", exact: true }).click();

    await expect
      .poll(() => !fs.existsSync(sentinel) && fs.existsSync(dbPath), { timeout: 30_000 })
      .toBe(true);
    await expect(window.getByRole("button", { name: "Reset Sample Library" })).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus()), {
      timeout: 30_000,
    }).toMatchObject({ status: "succeeded" });
    const rebuiltJob = await window.evaluate(() => window.mediaWorkspace.getImportStatus());
    expect(rebuiltJob.jobId).not.toBe(previousJob.jobId);
    // Still inside the sample catalog; the demo photos re-import.
    await expect(window.getByText(/browsing the sample library/i)).toBeVisible({ timeout: 30_000 });
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 120_000 });
    expect(mainLogs.slice(logStart).join("")).not.toContain("Error occurred in handler for 'workspace:reset-sample-catalog'");
  });
});
