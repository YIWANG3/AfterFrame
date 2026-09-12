const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test("folders scroll independently inside the rounded sidebar", async () => {
  const ctx = await launchApp({ testName: "sidebar-scroll" });
  const page = ctx.window;
  try {
    await expect(page.getByTestId("sidebar-folder-scroll")).toBeVisible();
    await page.evaluate(async () => {
      for (let i = 0; i < 30; i++) {
        await window.mediaWorkspace.createCollection(`Scroll folder ${String(i).padStart(2, "0")}`, "manual");
      }
    });
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    await page.reload();
    const list = page.getByTestId("sidebar-folder-scroll");
    await expect(list.getByRole("button", { name: /Scroll folder 29/ })).toBeAttached();
    const sidebar = page.locator("aside.border-r");
    await expect(sidebar.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(sidebar).toHaveCSS("clip-path", "inset(0px round 18px)");
    const nav = page.getByRole("button", { name: /^All Assets/ }).first();
    for (const mode of ["list", "covers"]) {
      if (mode === "covers") await page.getByRole("button", { name: "Show covers", exact: true }).click();
      await list.evaluate((el) => { el.scrollTop = 0; });
      const listBox = await list.boundingBox();
      const navBefore = await nav.boundingBox();
      await list.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await nav.boundingBox()).toEqual(navBefore);
      expect(await page.locator("aside.border-r").evaluate((el) => el.scrollTop)).toBe(0);
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const last = list.getByRole("button", { name: /Scroll folder 29/ });
      const lastBox = await last.boundingBox();
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listBox.y + listBox.height);
      await last.click();
      await page.keyboard.press("Meta+,");
      await expect(page.getByRole("button", { name: "General", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  } finally {
    await closeApp(ctx.app, ctx.userDataDir);
  }
});
