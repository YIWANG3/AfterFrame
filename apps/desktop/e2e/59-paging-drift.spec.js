const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");
const { cloneAssets } = require("./helpers/clone-assets");

// The gallery pages by offset. When the view gains photos between two pages
// (a watched folder importing, an annotation run adding matches) the next page
// starts with rows already on screen. The grid keys cards by asset_id, so the
// repeats were duplicate React keys: one copy remounted on every scroll and
// its thumbnail blinked as it reloaded, and a selection ring showed on both.

const BULK = 600; // several pages of 180, so a page is still to come once the first loads settle

test.describe("Gallery paging", () => {
  let app, window, userDataDir, catalogDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir, catalogDir } = await launchApp({
      testName: "paging-drift",
      prepareCatalog: (dir) => cloneAssets(dir, Array.from({ length: BULK }, (_, i) => `bulk-${String(i + 1).padStart(4, "0")}`)),
    }));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("photos landing ahead of the loaded pages don't repeat cards", async () => {
    const scroller = window.locator("[data-testid='gallery-scroll']");
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });

    // Let the opening page (and any preload it triggers) settle.
    const scrollHeight = () => scroller.evaluate((el) => el.scrollHeight);
    let last = -1;
    await expect.poll(async () => {
      const now = await scrollHeight();
      const settled = now === last;
      last = now;
      return settled;
    }, { timeout: 15_000, intervals: [1000] }).toBe(true);

    // Eight photos arrive that sort ahead of everything loaded so far.
    cloneAssets(catalogDir, Array.from({ length: 8 }, (_, i) => `000-late-${i + 1}`));

    const before = await scrollHeight();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(scrollHeight, { timeout: 15_000 }).toBeGreaterThan(before);

    // Walk the whole grid; a repeated card sits within a row or two of its
    // twin, so both are rendered in the same window.
    const repeated = await scroller.evaluate(async (el) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const found = new Set();
      for (let top = 0; top <= el.scrollHeight; top += Math.max(100, el.clientHeight / 2)) {
        el.scrollTop = top;
        await frame();
        const seen = new Set();
        for (const card of el.querySelectorAll("[data-gallery-item='true']")) {
          if (seen.has(card.dataset.assetId)) found.add(card.dataset.assetId);
          seen.add(card.dataset.assetId);
        }
      }
      return [...found];
    });
    expect(repeated).toEqual([]);
  });
});
