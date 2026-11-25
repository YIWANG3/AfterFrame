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

// Smart collections beside forty collections and the folders on disk: the
// sections share the sidebar in proportion to their rows, and the short one
// used to give way down to its heading. Now an open section keeps its first
// rows (sidebarSectionFloors.js), held to an even split in a short window so
// that all of them still fit.
//
// The window is set to 1080×680 here, the most the CI machine's screen gives,
// so the sidebar is the same height everywhere.
test("a short section beside a long one keeps its first rows in view", async () => {
  const ctx = await launchApp({ testName: "sidebar-floors" });
  const page = ctx.window;
  try {
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) await window.mediaWorkspace.createCollection(`Long list ${String(i).padStart(2, "0")}`, "manual");
      for (let i = 1; i <= 12; i++) await window.mediaWorkspace.createCollection(`Rated ${i}`, "smart", { filters: { rating_min: 1 } });
    });
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(900, 600);
      win.setSize(1080, 680);
    });
    const nav = page.locator("aside.border-r nav");
    // Each open section's rows wholly inside its list's visible box.
    const SECTIONS = {
      smart: ["[data-smart-collections-list]", "[data-smart-collection]"],
      collections: ["[data-testid='sidebar-folder-scroll']", "[data-collection-id]"],
      folders: ["[data-disk-folders-list]", "[data-disk-folder]"],
    };
    const rowsInView = () => nav.evaluate((el, sections) => Object.fromEntries(Object.entries(sections).map(([name, [listSel, rowSel]]) => {
      const list = el.querySelector(listSel);
      if (!list) return [name, -1];
      const box = list.getBoundingClientRect();
      const inView = Array.from(list.querySelectorAll(rowSel))
        .filter((row) => { const r = row.getBoundingClientRect(); return r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5; });
      return [name, inView.length];
    })), SECTIONS);
    const sectionsFit = () => nav.evaluate((el) => {
      const bottom = el.getBoundingClientRect().bottom;
      return Array.from(el.children).every((child) => child.getBoundingClientRect().bottom <= bottom + 0.5);
    });
    // With the entries above put away (Settings › General › Sidebar) the three
    // sections still don't all fit: each keeps its first three rows, the one
    // folder on disk included (it used to be the one squeezed to its heading).
    // With every entry shown each keeps at least one, and none is pushed out.
    const ABOVE = ["recent", "rated", "lookalikes", "discover", "stickers", "people", "tags", "stats"];
    for (const [hidden, least] of [[ABOVE, { smart: 3, collections: 3, folders: 1 }], [[], { smart: 1, collections: 1, folders: 1 }]]) {
      await page.evaluate((list) => localStorage.setItem("afterframe.pref.sidebar.hidden", JSON.stringify(list)), hidden);
      await page.reload();
      await expect(page.getByTestId("sidebar-folder-scroll").getByRole("button", { name: /Long list 39/ })).toBeAttached();
      await expect(page.locator("[data-smart-collection]")).toHaveCount(12);
      for (const mode of ["list", "covers"]) {
        const covers = await page.locator("[data-smart-collection] img, [data-smart-collection] .h-10").count() > 0;
        if ((mode === "covers") !== covers) {
          await page.getByTestId("sidebar-more-collections").click();
          await page.locator("[data-section-more-menu] [data-menu-item='view']").click();
        }
        const label = `${hidden.length ? "entries above hidden" : "every entry shown"}, ${mode}`;
        await expect.poll(async () => {
          const seen = await rowsInView();
          return Object.keys(least).filter((name) => seen[name] < least[name]).map((name) => `${name} ${seen[name]}`);
        }, { message: `${label}: sections short of their first rows` }).toEqual([]);
        expect(await sectionsFit(), `${label}: every section inside the sidebar`).toBe(true);
        // The long list still scrolls inside itself.
        expect(await page.getByTestId("sidebar-folder-scroll").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      }
    }
  } finally {
    await closeApp(ctx.app, ctx.userDataDir);
  }
});
