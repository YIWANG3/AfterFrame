// Smoke test 1 — App launches cleanly and the main window renders.
// This is the cheapest test: if it passes, we know the renderer build is
// servable and main.js doesn't throw on startup (which is enough to catch
// most refactor breakage).

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("App launch", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "launch" }));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("main window opens", async () => {
    expect(window).toBeTruthy();
  });

  test("title is AfterFrame", async () => {
    const title = await window.title();
    expect(title.toLowerCase()).toContain("afterframe");
  });

  test("no fatal console errors during startup", async () => {
    const errors = [];
    window.on("pageerror", (e) => errors.push(e.message));
    // Brief settle window for any async errors after first-window
    await window.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });

  test("sidebar navigation renders", async () => {
    // Either the welcome/empty state OR the sidebar is visible — both are valid.
    // We just check that *some* recognisable UI shows up.
    await expect(
      window.locator("body").getByText(/AfterFrame|Stickers|All Assets|Folders|Welcome|catalog/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
