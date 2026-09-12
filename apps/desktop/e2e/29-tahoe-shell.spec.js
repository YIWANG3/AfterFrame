const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Tahoe window and toolbar", () => {
  let ctx;
  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "tahoe-shell" });
    await expect(ctx.window.locator(".app-toolbar")).toBeVisible();
  });
  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("minimum window width keeps toolbar actions inside the pane", async () => {
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    const page = ctx.window;
    await expect(page.locator(".toolbar-thumbsize")).toBeHidden();
    await expect(page.locator(".toolbar-modes")).toBeHidden();
    await expect(page.locator(".app-toolbar .truncate").first()).toBeVisible();
    const pane = await page.locator(".app-toolbar").boundingBox();
    for (const name of ["Refresh", "Background activity", "Filters"]) {
      const button = page.getByRole("button", { name, exact: true });
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
      await button.click({ trial: true });
    }
  });

  test("add menu dismisses on outside click and Escape", async () => {
    const page = ctx.window;
    const trigger = page.locator(".app-toolbar > div").first().getByRole("button").first();
    const action = page.getByRole("button", { name: "Import", exact: true });
    await trigger.click();
    await expect(action).toBeVisible();
    await page.getByRole("button", { name: /All Assets/ }).first().click();
    await expect(action).toBeHidden();
    await trigger.click();
    await expect(action).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(action).toBeHidden();
  });

  test("production entry updates the shell on entering and leaving fullscreen", async () => {
    const page = ctx.window;
    expect(page.url()).toMatch(/^file:/);
    try {
      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
      await expect(page.locator("html")).toHaveClass(/\bfs\b/, { timeout: 15000 });
      await expect(page.locator("#root")).toHaveCSS("clip-path", "none");
    } finally {
      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    }
    await expect(page.locator("html")).not.toHaveClass(/\bfs\b/, { timeout: 15000 });
    await expect(page.locator("#root")).not.toHaveCSS("clip-path", "none");
  });
});
