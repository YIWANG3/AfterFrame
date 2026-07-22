// Map drawer — offline geo browse (Phase 1, GPS-only).
// The seeded catalog carries two GPS assets (001-red → Paris, 002-orange →
// Tokyo; see seed-catalog.js step 6) on a schema-8 DB. Covers: toggle expands
// the drawer without replacing the Gallery, panning engages the viewport
// filter (Location chip + narrowed gallery), removing the chip restores the
// full gallery, and collapsing the map keeps the filter.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Map drawer", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "map" }));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("map toggle expands the drawer and keeps the gallery DOM", async () => {
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
    // Tag the gallery scroll container so we can prove the same DOM node
    // survives the toggle (items are virtualized, so tiles may re-mount when
    // the gallery height changes — the container must not).
    await window.locator("[data-testid='gallery-scroll']").evaluate((el) => { el.dataset.mapSpecSentinel = "1"; });

    const drawer = window.locator("[data-testid='map-drawer']");
    expect(await drawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);

    await window.locator("[data-testid='map-toggle']").click();
    // Drawer opens (400 ms animation) and the map initializes — the 22 MB
    // base-map chunk parse can take a moment on first open.
    await expect
      .poll(async () => drawer.evaluate((el) => el.getBoundingClientRect().height), { timeout: 15_000 })
      .toBeGreaterThan(200);
    await expect(window.locator(".photo-map-stage[data-map-ready='true']")).toBeVisible({ timeout: 30_000 });

    // Same gallery instance, not a copy: the sentinel container is still there
    // with tiles inside it.
    await expect(window.locator("[data-testid='gallery-scroll'][data-map-spec-sentinel='1']")).toHaveCount(1);
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible();

    // Two far-apart GPS points → photo markers appear on the world view.
    await expect(window.locator(".photo-map-marker").first()).toBeVisible({ timeout: 15_000 });
  });

  test("panning the map engages the viewport filter and narrows the gallery", async () => {
    // Deterministic camera move via the map test backdoor (a real pointer drag
    // through the WebGL canvas is timing-sensitive under automation). Zooming
    // to Europe leaves only the Paris asset in the viewport.
    await window.evaluate(() => window.__afterframeMapTest.jumpTo([2.35, 48.85], 5));

    await expect(window.locator("[data-testid='geo-filter-chip']")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(1, { timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']").first()).toHaveAttribute("data-asset-id", /.+/);
  });

  test("removing the Location chip restores the gallery but keeps the map open", async () => {
    await window.locator("[data-testid='geo-filter-chip']").click();
    await expect(window.locator("[data-testid='geo-filter-chip']")).toHaveCount(0);
    await expect
      .poll(async () => window.locator("[data-gallery-item='true']").count(), { timeout: 10_000 })
      .toBeGreaterThan(2);
    // Map still expanded.
    const drawer = window.locator("[data-testid='map-drawer']");
    expect(await drawer.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(200);
  });

  test("collapsing the map clears the geo filter", async () => {
    // Re-engage the viewport filter: Tokyo viewport → only 002-orange remains.
    await window.evaluate(() => window.__afterframeMapTest.jumpTo([139.69, 35.68], 5));
    await expect(window.locator("[data-testid='geo-filter-chip']")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(1, { timeout: 10_000 });

    await window.locator("[data-testid='map-toggle']").click();
    const drawer = window.locator("[data-testid='map-drawer']");
    await expect
      .poll(async () => drawer.evaluate((el) => el.getBoundingClientRect().height), { timeout: 10_000 })
      .toBe(0);
    // With the map hidden the viewport filter has no visible anchor — closing
    // the drawer drops it and the full gallery comes back.
    await expect(window.locator("[data-testid='geo-filter-chip']")).toHaveCount(0);
    await expect
      .poll(async () => window.locator("[data-gallery-item='true']").count(), { timeout: 10_000 })
      .toBeGreaterThan(2);
  });

  test("AI-inferred location appears on the map and in the geo filter", async () => {
    // 004-green carries an AI annotation resolved to Sydney (locality
    // precision, source='ai') by the fixture's gazetteer backfill. Re-open the
    // map first (previous test collapsed it).
    await window.locator("[data-testid='map-toggle']").click();
    const drawer = window.locator("[data-testid='map-drawer']");
    await expect
      .poll(async () => drawer.evaluate((el) => el.getBoundingClientRect().height), { timeout: 10_000 })
      .toBeGreaterThan(200);

    await window.evaluate(() => window.__afterframeMapTest.jumpTo([151.21, -33.87], 5));
    await expect(window.locator("[data-testid='geo-filter-chip']")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(1, { timeout: 10_000 });
    await expect(window.locator("[data-gallery-item='true']").first()).toContainText("004-green");
    // Clean up for the following tests: drop the geo filter by collapsing.
    await window.locator("[data-testid='map-toggle']").click();
    await expect(window.locator("[data-testid='geo-filter-chip']")).toHaveCount(0, { timeout: 10_000 });
  });

  test("keyboard M re-opens the map", async () => {
    await window.locator("[data-testid='gallery-scroll']").click();
    await window.keyboard.press("m");
    const drawer = window.locator("[data-testid='map-drawer']");
    await expect
      .poll(async () => drawer.evaluate((el) => el.getBoundingClientRect().height), { timeout: 10_000 })
      .toBeGreaterThan(200);
    // Display-mode switching (now a dropdown) stays available while the map
    // is open.
    await window.locator("[data-testid='display-mode-trigger']").click();
    await window.locator("[data-testid='display-mode-tiles']").click();
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible();
  });
});
