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
      if (mode === "covers") {
        await page.getByTestId("sidebar-more-collections").click();
        await page.locator("[data-section-more-menu] [data-menu-item='view']").click();
      }
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
      await page.keyboard.press("ControlOrMeta+,");
      await expect(page.getByRole("button", { name: "General", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  } finally {
    await closeApp(ctx.app, ctx.userDataDir);
  }
});

// Three smart collections beside forty collections and the folders on disk:
// the sections share the sidebar in proportion to their rows, and the short
// one used to give way down to its heading. Now an open section keeps its
// first rows (sidebarSectionFloors.js), held to an even split in a short
// window so that all of them still fit.
test("a short section beside a long one keeps its first rows in view", async () => {
  const ctx = await launchApp({ testName: "sidebar-floors" });
  const page = ctx.window;
  try {
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) await window.mediaWorkspace.createCollection(`Long list ${String(i).padStart(2, "0")}`, "manual");
      for (const name of ["Rated one", "Rated two", "Rated three"]) await window.mediaWorkspace.createCollection(name, "smart", { filters: { rating_min: 1 } });
    });
    const smartList = page.locator("[data-smart-collections-list]");
    const nav = page.locator("aside.border-r nav");
    // The rows wholly inside their list's visible box.
    const rowsInView = () => smartList.evaluate((list) => {
      const box = list.getBoundingClientRect();
      return Array.from(list.querySelectorAll("[data-smart-collection]"))
        .filter((row) => { const r = row.getBoundingClientRect(); return r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5; }).length;
    });
    const sectionsFit = () => nav.evaluate((el) => {
      const bottom = el.getBoundingClientRect().bottom;
      return Array.from(el.children).every((child) => child.getBoundingClientRect().bottom <= bottom + 0.5);
    });
    for (const [width, height, inList, inCovers] of [[1440, 920, 3, 3], [1080, 720, 1, 1]]) {
      await ctx.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
      await page.reload();
      await expect(page.getByTestId("sidebar-folder-scroll").getByRole("button", { name: /Long list 39/ })).toBeAttached();
      await expect(page.locator("[data-smart-collection]")).toHaveCount(3);
      for (const [mode, least] of [["list", inList], ["covers", inCovers]]) {
        const covers = await page.locator("[data-smart-collection] img, [data-smart-collection] .h-10").count() > 0;
        if ((mode === "covers") !== covers) {
          await page.getByTestId("sidebar-more-collections").click();
          await page.locator("[data-section-more-menu] [data-menu-item='view']").click();
        }
        await expect.poll(rowsInView, { message: `${width}×${height} ${mode}` }).toBeGreaterThanOrEqual(least);
        expect(await sectionsFit(), `${width}×${height} ${mode}: every section inside the sidebar`).toBe(true);
        // The long list still scrolls inside itself.
        expect(await page.getByTestId("sidebar-folder-scroll").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      }
    }
  } finally {
    await closeApp(ctx.app, ctx.userDataDir);
  }
});
