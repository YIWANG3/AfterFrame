const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards, openEditorOn, closeEditor } = require("./helpers/app");
const { splitsImport } = require("../electron/importDialog");

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
    // Windows and Linux split Import into Import Files… / Import Folder… (#123).
    const action = page.getByRole("button", { name: splitsImport(process.platform) ? "Import Files…" : "Import", exact: true });
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
      await ctx.app.evaluate(({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const item = Menu.getApplicationMenu().getMenuItemById("toggle-fullscreen");
        item.click(item, window, {});
      });
      await expect(page.locator("html")).toHaveClass(/\bfs\b/, { timeout: 15000 });
      await expect(page.locator("#root")).toHaveCSS("clip-path", "none");
    } finally {
      await ctx.app.evaluate(({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const isFullScreen = process.platform === "darwin" ? window.isSimpleFullScreen() : window.isFullScreen();
        if (isFullScreen) {
          const item = Menu.getApplicationMenu().getMenuItemById("toggle-fullscreen");
          item.click(item, window, {});
        }
      });
    }
    await expect(page.locator("html")).not.toHaveClass(/\bfs\b/, { timeout: 15000 });
    // The rounded clip belongs to the transparent macOS window; Windows draws an
    // opaque native frame and never clips.
    if (process.platform === "darwin") await expect(page.locator("#root")).not.toHaveCSS("clip-path", "none");
  });

  // macOS draws the traffic lights over the page, and they don't follow the
  // interface scale (page zoom) while every CSS size does. Whatever the
  // scale, no text and no control may sit on them: not in the window, not in
  // the lightbox, not in the editor. The lightbox's file name is the one
  // thing beside them; it keeps the same 12pt from the green light at every
  // scale (index.css 4b, --pt) and moves back to the edge in full screen,
  // where there are no lights.
  test("nothing sits on the traffic lights at any interface scale", async () => {
    test.skip(process.platform !== "darwin", "the traffic lights are macOS's");
    const page = ctx.window;
    const title = page.locator("[data-layer='lightbox'] [data-lightbox-title]");
    const toggleFullscreen = () => ctx.app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu().getMenuItemById("toggle-fullscreen");
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    });
    const setScale = async (scale) => {
      await page.evaluate((s) => window.mediaWorkspace.setUiScale(s), scale);
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom").trim())).toBe(String(scale));
    };
    // Text and controls under `selector` that overlap the lights, in screen
    // points: three 14pt dots from x 16 to 76 and y 15 to 29, and 4pt round.
    // Hidden ones count too (the lightbox's bars and the hover-only buttons
    // come out under the pointer); display: none leaves no box to count.
    const onTheLights = (selector, scale) => page.evaluate(({ selector, scale }) => {
      const lights = { left: 12, top: 11, right: 80, bottom: 33 };
      const hits = [];
      const check = (rect, what) => {
        if (!rect.width || !rect.height) return;
        const [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom].map((v) => v * scale);
        if (left < lights.right && right > lights.left && top < lights.bottom && bottom > lights.top) {
          hits.push(`${what} at ${Math.round(left)},${Math.round(top)}pt`);
        }
      };
      const root = document.querySelector(selector);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) check(rect, JSON.stringify(node.textContent.trim().slice(0, 30)));
      }
      for (const el of root.querySelectorAll("button, input, select, textarea")) {
        check(el.getBoundingClientRect(), el.getAttribute("aria-label") || el.tagName.toLowerCase());
      }
      return hits;
    }, { selector, scale });

    await expect(galleryCards(page).first()).toBeVisible({ timeout: 15_000 });
    const photo = await galleryCards(page).first().getAttribute("data-image-path");
    try {
      for (const scale of [1, 0.9, 0.8, 1.1, 1.25]) {
        await setScale(scale);
        expect(await onTheLights("#root", scale), `the window at ${scale}`).toEqual([]);

        await galleryCards(page).first().dblclick();
        await expect(title).toBeAttached({ timeout: 10_000 });
        expect(await onTheLights("[data-layer='lightbox']", scale), `the lightbox at ${scale}`).toEqual([]);
        const nameLeft = await title.evaluate((el, s) => el.getBoundingClientRect().left * s, scale);
        expect(Math.abs(nameLeft - 88), `the file name starts at ${nameLeft}pt at ${scale}`).toBeLessThanOrEqual(1);
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-layer='lightbox']")).toHaveCount(0);

        await openEditorOn(page, photo);
        expect(await onTheLights("[data-layer='editor']", scale), `the editor at ${scale}`).toEqual([]);
        await closeEditor(page);
      }

      await setScale(1);
      await galleryCards(page).first().dblclick();
      await expect(title).toBeAttached({ timeout: 10_000 });
      await toggleFullscreen();
      await expect(page.locator("html")).toHaveClass(/\bfs\b/, { timeout: 15_000 });
      await expect.poll(() => title.evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(24);
    } finally {
      await ctx.app.evaluate(({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isSimpleFullScreen()) {
          const item = Menu.getApplicationMenu().getMenuItemById("toggle-fullscreen");
          item.click(item, window, {});
        }
      });
      await page.evaluate(() => window.mediaWorkspace.setUiScale(1));
      if (await page.locator("[data-layer='lightbox']").count()) await page.keyboard.press("Escape");
    }
    await expect(page.locator("html")).not.toHaveClass(/\bfs\b/, { timeout: 15_000 });
    await expect(page.locator("[data-layer='lightbox']")).toHaveCount(0);
  });
});
