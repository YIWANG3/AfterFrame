const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

// Cluster markers show three cover photos. Every marker refresh (each moveend,
// each tile a drag loads) used to blank those covers and fetch them again, so
// all cluster thumbnails blinked while the map was dragged.

// Four more photos around Paris: with 001-red they form one cluster at world zoom.
const NEAR_PARIS = [
  ["003-yellow", 48.86, 2.34],
  ["007-purple", 48.85, 2.36],
  ["005-teal", 48.87, 2.35],
  ["006-blue", 48.84, 2.33],
];

function addLocations(catalogDir) {
  const db = path.join(catalogDir, "catalog.sqlite3");
  const sql = NEAR_PARIS.map(([stem, lat, lon]) => `
    INSERT INTO asset_locations (asset_id, latitude, longitude, min_latitude, max_latitude,
                                 min_longitude, max_longitude, source, precision_level, country_code)
      SELECT asset_id, ${lat}, ${lon}, ${lat}, ${lat}, ${lon}, ${lon}, 'manual', 'exact', 'FR'
      FROM assets WHERE stem = '${stem}';
    INSERT INTO asset_location_rtree (location_id, min_longitude, max_longitude, min_latitude, max_latitude)
      VALUES (last_insert_rowid(), ${lon}, ${lon}, ${lat}, ${lat});
  `).join("");
  execFileSync("sqlite3", [db, sql]);
}

test.describe("Map cluster covers", () => {
  test.skip(!!process.env.CI, "no GPU/WebGL on the GitHub macOS runner: MapLibre never renders");

  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "map-cluster-covers", prepareCatalog: addLocations }));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("dragging the map leaves cluster covers in place", async () => {
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
    await window.locator("[data-testid='map-toggle']").click();
    await expect(window.locator(".photo-map-stage[data-map-ready='true']")).toBeVisible({ timeout: 30_000 });

    const parisCluster = window.locator(".photo-map-marker", { has: window.locator(".photo-map-marker__count", { hasText: "5" }) });
    await expect(parisCluster).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => parisCluster.evaluate((marker) => [...marker.querySelectorAll(".photo-map-marker__photo")]
      .every((img) => img.getAttribute("src") && img.complete)), { timeout: 15_000 }).toBe(true);

    // Record every cover that loses its picture from here on.
    await parisCluster.evaluate((marker) => {
      window.__blankedCovers = 0;
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) if (!m.target.getAttribute("src")) window.__blankedCovers += 1;
      });
      for (const img of marker.querySelectorAll(".photo-map-marker__photo")) observer.observe(img, { attributes: true, attributeFilter: ["src"] });
      marker.dataset.coverSpec = "1";
    });

    // Small pans at the same zoom: the cluster stays the same marker.
    const { center, zoom } = await window.evaluate(() => window.__afterframeMapTest.getState());
    for (const dx of [4, 8, 4, 0]) {
      await window.evaluate(([c, z]) => window.__afterframeMapTest.jumpTo(c, z), [[center[0] + dx, center[1]], zoom]);
      await window.waitForTimeout(250);
    }

    await expect(window.locator(".photo-map-marker[data-cover-spec='1']")).toHaveCount(1);
    expect(await window.evaluate(() => window.__blankedCovers)).toBe(0);

    // At max zoom the cluster breaks up; back out, a new cluster marker is
    // made and it still gets its covers.
    await window.evaluate(() => window.__afterframeMapTest.jumpTo([2.35, 48.855], 14));
    await expect(parisCluster).toHaveCount(0, { timeout: 5_000 });
    await window.evaluate(([c, z]) => window.__afterframeMapTest.jumpTo(c, z), [center, zoom]);
    // jumpTo's moveend fires before the next frame swaps in the low-zoom tiles;
    // a second nudge once it has rendered reads the right ones.
    await window.waitForTimeout(500);
    await window.evaluate(([c, z]) => window.__afterframeMapTest.jumpTo(c, z), [[center[0] + 1, center[1]], zoom]);
    await expect(parisCluster).toHaveCount(1, { timeout: 5_000 });
    await expect(window.locator(".photo-map-marker[data-cover-spec='1']")).toHaveCount(0);
    await expect.poll(() => parisCluster.evaluate((marker) => [...marker.querySelectorAll(".photo-map-marker__photo")]
      .every((img) => img.getAttribute("src") && img.complete)), { timeout: 5_000 }).toBe(true);
  });
});
