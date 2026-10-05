// Smoke test 2 — Sidebar navigation works between views.
// Doesn't depend on having a catalog loaded; just verifies the nav buttons
// react and the right pane swaps content.

const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, lacks } = require("./helpers/app");

test.describe("Sidebar navigation", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "nav" }));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("can switch to Stickers view", async () => {
    test.skip(lacks("stickerExtract"), "the sticker browser and tool are macOS-only for now (electron/capabilities.js)");
    const stickersBtn = window.getByRole("button", { name: /Stickers/i }).first();
    await expect(stickersBtn).toBeVisible({ timeout: 10_000 });
    await stickersBtn.click();
    // StickerView actually rendered: the seeded library is empty, so its
    // empty state is the anchor (the old assertion matched the nav button
    // itself and passed without the view mounting).
    await expect(window.getByText(/No stickers yet/i)).toBeVisible({ timeout: 5_000 });
  });

  test("can switch back to All Assets", async () => {
    const allAssetsBtn = window.getByRole("button", { name: /All Assets/i }).first();
    await expect(allAssetsBtn).toBeVisible();
    await allAssetsBtn.click();
    // Back in the asset gallery: seeded cards are visible again
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 5_000 });
  });

  test("Recently Added and Rated filters load real data", async () => {
    const recent = window.getByRole("button", { name: /Recently Added/i }).first();
    await expect(recent).toBeVisible();
    await recent.click();
    // The seeded catalog was imported long ago, so nothing is "recent": the view
    // is honestly empty. (This used to assert "an item is visible", which only
    // passed because the previous view's photos were still on screen for a
    // moment after the click. Changing place now clears the grid at once.)
    await expect(window.getByTestId("gallery-title")).toHaveText("Recently Added");
    await expect(window.getByText("No assets in this view")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(0);

    // Four rated assets exist, so the Rated entry renders (gated on
    // rated_count > 0) and filters down to exactly them: two synthetic
    // images seeded at 4 stars, plus two real photographs whose original
    // XMP carries an embedded 5-star rating that import reads through.
    const rated = window.getByRole("button", { name: /Rated/i }).first();
    await expect(rated).toBeVisible();
    await rated.click();
    // Wait for the filtered gallery to actually re-query and paint before
    // counting — under full-suite contention the re-query can take several
    // seconds, and a bare toHaveCount raced an empty (0-item) intermediate
    // state. Anchor on "at least one item visible" first, then assert exactly
    // the four rated assets.
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(4, { timeout: 10_000 });

    // restore
    await window.getByRole("button", { name: /All Assets/i }).first().click();
  });

  // Changing place and straight back. With the answer for the place left
  // still out, the way back skipped its browse ("already showing this" was
  // still true from before), so that answer landed last and won: CI showed
  // All Assets' 14 photos under a smart collection's title (e2e/46). Here the
  // answers are held back behind read-only scans of a big folder (the
  // watched-folder catch-up check, which lists new files and imports nothing)
  // on the resident sidecar, which answers in order, so they are still out
  // when the second click comes, however fast the machine.
  test.describe("changing place and straight back", () => {
    const cards = () => window.locator("[data-gallery-item='true']");
    const title = () => window.getByTestId("gallery-title");
    const holdSidecar = () => window.evaluate((dir) => {
      for (let i = 0; i < 3; i += 1) void window.mediaWorkspace.scanNewMedia([dir]);
    }, path.resolve(__dirname, "..", "node_modules"));
    // Everything asked before this has been answered, and painted.
    const settle = async () => {
      await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1 }));
      await window.waitForTimeout(500);
    };

    test.beforeEach(async () => {
      await window.getByRole("button", { name: /^All Assets/ }).first().click();
      await expect(cards()).toHaveCount(14, { timeout: 10_000 });
    });

    test("away and back shows where you came back to", async () => {
      await holdSidecar();
      await window.getByRole("button", { name: /^Rated/ }).first().click();
      await expect(title()).toHaveText("Rated");
      await window.getByRole("button", { name: /^All Assets/ }).first().click();
      await expect(title()).toHaveText("All Assets");
      await settle();
      await expect(cards()).toHaveCount(14);
    });

    // A filter changes the view without clearing the grid; the filtered
    // answer used to stay the same way.
    test("a filter put on and straight off again shows the view without it", async () => {
      if (!await window.locator("[data-filter-bar]").isVisible()) await window.getByRole("button", { name: "Filters" }).click();
      await holdSidecar();
      const fourStars = window.getByTitle("Rating ≥ 4");
      await fourStars.click();
      await fourStars.click();
      await settle();
      await expect(cards()).toHaveCount(14);
    });

    // Both clicks in one task are one batch of updates: the render ends where
    // it started, so the browse effect saw no change of place, but the first
    // click had cleared the grid. It stayed empty.
    test("away and back in one batch of updates shows where you came back to", async () => {
      await window.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")];
        buttons.find((button) => /^Rated/.test(button.textContent.trim())).click();
        buttons.find((button) => /^All Assets/.test(button.textContent.trim())).click();
      });
      await expect(title()).toHaveText("All Assets");
      await settle();
      await expect(cards()).toHaveCount(14);
    });
  });

  // Leaving a folder. The status entries used to mark the library as "already
  // shown" before going there (clearCollection reload:false), so the grid was
  // cleared for the new place and then never browsed: All Assets opened as
  // "No assets in this view" until a filter was toggled. The same mark, set on
  // the way to Discover or People, left the folder's photos on screen under
  // the All Assets title afterwards.
  test.describe("leaving a folder", () => {
    const cards = () => window.locator("[data-gallery-item='true']");
    const cardIds = () => cards().evaluateAll((els) => els.map((el) => el.dataset.assetId).sort());
    let library; // every asset in the seeded catalog
    let members; // the two put in the folder

    test.beforeAll(async () => {
      await window.getByRole("button", { name: /All Assets/i }).first().click();
      await expect(cards().first()).toBeVisible({ timeout: 10_000 });
      await window.getByTitle("New folder").click();
      const nameInput = window.getByRole("navigation").locator("input");
      await nameInput.fill("Leave me");
      await nameInput.press("Enter");
      await expect(window.getByRole("button", { name: /^Leave me/ })).toBeVisible();
      ({ library, members } = await window.evaluate(async () => {
        const bridge = window.mediaWorkspace;
        const rows = await bridge.browseImages({ status: "all", limit: 1000 });
        const folder = (await bridge.listCollections()).find((c) => c.name === "Leave me");
        const picked = rows.slice(0, 2).map((r) => r.asset_id);
        await bridge.collectionAddItems(folder.collection_id, picked);
        return { library: rows.map((r) => r.asset_id).sort(), members: [...picked].sort() };
      }));
      expect(library.length).toBeGreaterThan(2);
    });

    const openFolder = async () => {
      await window.getByRole("button", { name: /^Leave me/ }).click();
      await expect(cards()).toHaveCount(2);
      expect(await cardIds()).toEqual(members);
    };
    // The whole library, by id: neither empty nor the folder's two.
    const expectLibrary = async () => {
      await expect(window.getByTestId("gallery-title")).toHaveText("All Assets");
      await expect(cards()).toHaveCount(library.length, { timeout: 10_000 });
      expect(await cardIds()).toEqual(library);
      await expect(window.getByText("No assets in this view")).toHaveCount(0);
    };

    test("All Assets shows the library again, not an empty grid", async () => {
      await openFolder();
      await window.getByRole("button", { name: /All Assets/i }).first().click();
      await expectLibrary();
    });

    test("All Assets after a detour through Discover or People shows the library, not the folder", async () => {
      for (const view of ["Discover", "People"]) {
        await openFolder();
        await window.getByRole("button", { name: view, exact: true }).click();
        await window.getByRole("button", { name: /All Assets/i }).first().click();
        await expectLibrary();
      }
    });
  });
});
