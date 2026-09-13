const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("UI regression guards", () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "ui-regressions" });
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("People and Stickers use the same workspace header geometry as All Assets", async () => {
    const page = ctx.window;
    const geometry = (locator) => locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    const allAssetsToolbar = page.locator(".app-toolbar").first();
    const expected = await geometry(allAssetsToolbar);

    for (const view of ["Stickers", "People"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      const toolbar = page.locator(".library-toolbar");
      await expect(toolbar).toBeVisible();
      expect(await geometry(toolbar)).toEqual(expected);
      await expect(toolbar.getByRole("textbox")).toBeVisible();
    }
  });

  test("compare layout controls stay centered while Close stays at the right edge", async () => {
    const page = ctx.window;
    await page.getByRole("button", { name: /All Assets/ }).first().click();
    const cards = page.locator("[data-gallery-item='true']");
    await cards.nth(0).click();
    await cards.nth(1).click({ modifiers: ["Meta"] });
    await cards.nth(1).click({ button: "right" });
    await page.getByText("Compare", { exact: true }).click();

    const header = page.getByTestId("compare-header");
    const controls = page.getByTestId("compare-layout-controls");
    const close = page.getByTestId("compare-close");
    await expect(header).toBeVisible();
    const [headerBox, controlsBox, closeBox] = await Promise.all([
      header.boundingBox(), controls.boundingBox(), close.boundingBox(),
    ]);
    const headerCenter = headerBox.x + headerBox.width / 2;
    const controlsCenter = controlsBox.x + controlsBox.width / 2;
    expect(Math.abs(headerCenter - controlsCenter)).toBeLessThan(1);
    expect(closeBox.x).toBeGreaterThan(headerCenter);
    expect(headerBox.x + headerBox.width - (closeBox.x + closeBox.width)).toBeLessThanOrEqual(20);

    await close.click();
    await expect(header).toHaveCount(0);
  });
});
