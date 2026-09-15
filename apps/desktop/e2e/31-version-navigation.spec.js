const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Related version gallery navigation", () => {
  let app, window, userDataDir;
  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({
      testName: "version-navigation",
      prepareCatalog(catalogDir) {
        execFileSync("python3", [path.join(__dirname, "fixtures/seed-version-navigation.py"), catalogDir]);
      },
    }));
  });
  test.afterAll(async () => closeApp(app, userDataDir));

  const card = (id) => window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  const link = (id) => window.locator(`[data-testid='version-sibling'][data-asset-id='${id}']`);
  async function expectRevealed(id, name) {
    await expect(window.getByTestId("inspector-asset-title")).toHaveText(name);
    // No click/scrollIntoView here: the application must render and reveal
    // the virtualized target itself, not Playwright's action auto-scrolling.
    await expect(card(id)).toBeInViewport({ timeout: 15000 });
    await expect(card(id)).toHaveAttribute("data-selected", "true");
  }

  test("loads a version beyond page one and scrolls both directions", async () => {
    await expect(card("navigation-0000")).toBeVisible();
    await expect(card("navigation-0399")).toHaveCount(0);
    await card("navigation-0000").click();
    await link("navigation-0399").click();
    await expectRevealed("navigation-0399", "nav-0399.jpg");
    await link("navigation-0000").click();
    await expectRevealed("navigation-0000", "nav-0000.jpg");
  });

  test("preserves a search that includes the target, clears one that hides it", async () => {
    const search = window.getByPlaceholder("Search", { exact: true });
    await search.fill("nav-");
    // Click while search may still be debouncing: its late response must
    // not override the explicit version navigation.
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.locateImageAsset({
      assetId: "navigation-0399", search: "nav-", sort: "imported-desc",
    }))).toEqual({ index: 399 });
    await card("navigation-0000").click();
    await link("navigation-0399").click();
    await expectRevealed("navigation-0399", "nav-0399.jpg");
    await expect(search).toHaveValue("nav-");

    await search.fill("nav-0000");
    await expect(card("navigation-0000")).toBeVisible();
    await card("navigation-0000").click();
    await link("navigation-0399").click();
    await expectRevealed("navigation-0399", "nav-0399.jpg");
    await expect(search).toHaveValue("");
    await expect(window.getByText("Select an asset", { exact: true })).toHaveCount(0);
  });

  test("reveals a version excluded by the Rated view", async () => {
    // The previous test ends with the same toast (4s TTL); on slow CI runners
    // it can still be on screen here and make the assertion below ambiguous.
    const switchedToast = window.getByText("Switched to All Assets to show this version");
    await expect(switchedToast).toHaveCount(0, { timeout: 10000 });
    await window.getByRole("button", { name: /^Rated/ }).click();
    await expect(card("navigation-0000")).toBeVisible();
    await card("navigation-0000").click();
    await link("navigation-0399").click();
    await expectRevealed("navigation-0399", "nav-0399.jpg");
    await expect(switchedToast).toBeVisible();
  });
});
