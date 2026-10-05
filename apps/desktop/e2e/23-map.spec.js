// Map drawer — offline geo browse (Phase 1, GPS-only).
// The seeded catalog carries two GPS assets (001-red → Paris, 002-orange →
// Tokyo; see seed-catalog.js step 6) on a schema-8 DB. Covers: toggle expands
// the drawer without replacing the Gallery, panning engages the viewport
// filter (Location chip + narrowed gallery), removing the chip restores the
// full gallery, and collapsing the map keeps the filter.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");
const { tagPhoto, writeUniqueJpeg } = require("./helpers/images");
const { captureElement } = require("./helpers/screenshot");

test.describe("Map drawer", () => {
  // Runs nightly for the record, but the assertions cannot hold on the CI VM
  // (see .github/workflows/quality.yml). Skipped there so a red nightly means
  // something new; locally it runs in full.
  test.skip(!!process.env.CI, "no GPU/WebGL on the GitHub macOS runner: MapLibre never renders");

  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "map" }));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("map toggle expands the drawer and keeps the gallery DOM", async () => {
    // Inspect the resource used by this running app, not the workspace dist:
    // the installed .app may still contain an older build.
    expect(await app.evaluate(({ app }) => {
      const fs = process.getBuiltinModule("fs");
      const path = process.getBuiltinModule("path");
      return fs.existsSync(path.join(app.getAppPath(), "dist", "maplibre-worker.cjs"));
    })).toBe(true);
    const pageErrors = [];
    const recordPageError = (error) => pageErrors.push(error.message);
    window.on("pageerror", recordPageError);
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

    // Ready means a real WebGL frame, not merely that the HTML controls have
    // mounted over a black/zero-sized canvas.
    const canvas = window.locator("[data-testid='photo-map'] canvas");
    const canvasSize = await canvas.evaluate((element) => ({
      cssWidth: element.getBoundingClientRect().width,
      cssHeight: element.getBoundingClientRect().height,
      width: element.width,
      height: element.height,
    }));
    expect(canvasSize.cssWidth).toBeGreaterThan(400);
    expect(canvasSize.cssHeight).toBeGreaterThan(200);
    expect(canvasSize.width).toBeGreaterThan(400);
    expect(canvasSize.height).toBeGreaterThan(200);
    const pixels = await sharp(await captureElement(app, window, canvas)).stats();
    expect(Math.max(...pixels.channels.slice(0, 3).map((channel) => channel.stdev))).toBeGreaterThan(1);
    expect(pageErrors.filter((message) => message.includes("Cannot use import statement outside a module"))).toEqual([]);
    window.off("pageerror", recordPageError);

    // Same gallery instance, not a copy: the sentinel container is still there
    // with tiles inside it.
    await expect(window.locator("[data-testid='gallery-scroll'][data-map-spec-sentinel='1']")).toHaveCount(1);
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible();

    // Two far-apart GPS points → photo markers appear on the world view.
    await expect(window.locator(".photo-map-marker").first()).toBeVisible({ timeout: 15_000 });
    await test.info().attach("rendered-map", {
      body: await captureElement(app, window, drawer), contentType: "image/png",
    });
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

// A Discover memory is a date range AND a place. Opening the map on it used to
// replace the place with whatever the camera showed first (the world), which
// emptied the gallery; closing the map then dropped the place for good.
test.describe("A Discover place on the map", () => {
  test.skip(!!process.env.CI, "no GPU/WebGL on the GitHub macOS runner: MapLibre never renders");
  test.describe.configure({ mode: "serial" });

  const HONOLULU = [-157.8583, 21.3069];
  let app, window, userDataDir, dir;
  const cards = () => window.locator("[data-gallery-item='true']");
  const chip = () => window.locator("[data-testid='geo-filter-chip']");
  const drawer = () => window.locator("[data-testid='map-drawer']");
  const mapState = () => window.evaluate(() => window.__afterframeMapTest.getState());
  const toggleMap = async (open) => {
    await window.locator("[data-testid='map-toggle']").click();
    await expect.poll(() => drawer().evaluate((el) => el.getBoundingClientRect().height), { timeout: 10_000 })[open ? "toBeGreaterThan" : "toBe"](open ? 200 : 0);
  };
  // Long enough for the drawer animation, the framing and the 250 ms debounce
  // that would have replaced the filter.
  const settle = () => window.waitForTimeout(1_500);

  test.beforeAll(async () => {
    // Three days in Honolulu: a memory needs three photos of one visit.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-honolulu-")));
    const files = [];
    for (const day of ["02", "04", "06"]) {
      const file = await writeUniqueJpeg(path.join(dir, `honolulu-${day}.jpg`), { width: 320, height: 240 });
      files.push(tagPhoto(file, { taken: `2024:01:${day} 12:00:00`, gps: [HONOLULU[1], HONOLULU[0]] }));
    }
    ({ app, window, userDataDir } = await launchApp({ testName: "map-discover-place" }));
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
    }, files);
    await window.locator(".app-toolbar button").first().click();
    await window.getByRole("button", { name: "Import", exact: true }).click();
    for (const file of files) await expect(window.locator(`[data-image-path='${file}']`)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), { timeout: 30_000 }).toBe(false);

    // The map has been used before: its camera has been moved by the user,
    // which once made every later viewport count as deliberate.
    await toggleMap(true);
    await expect(window.locator(".photo-map-stage[data-map-ready='true']")).toBeVisible({ timeout: 30_000 });
    await window.evaluate(() => window.__afterframeMapTest.jumpTo([2.35, 48.85], 5));
    await expect(chip()).toBeVisible({ timeout: 10_000 });
    await toggleMap(false);
    await expect(chip()).toHaveCount(0);
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("opening the map keeps the memory's place and frames it", async () => {
    await window.getByRole("navigation").first().getByRole("button", { name: "Discover" }).click();
    await window.getByRole("button", { name: /^Honolulu/ }).click();
    await expect(cards()).toHaveCount(3, { timeout: 10_000 });
    await expect(chip()).toHaveText("Honolulu");

    await toggleMap(true);
    await settle();
    await expect(chip()).toHaveText("Honolulu");
    await expect(cards()).toHaveCount(3);
    const { center, zoom, bounds } = await mapState();
    expect(Math.abs(center[0] - HONOLULU[0])).toBeLessThan(1);
    expect(Math.abs(center[1] - HONOLULU[1])).toBeLessThan(1);
    expect(zoom).toBeGreaterThan(6);
    // The level switcher and the marker size follow the framed zoom.
    await expect(window.locator(".photo-map-stage")).toHaveAttribute("data-marker-mode", "detail");
    // The photos are on screen, not just near the centre.
    expect(bounds[0][0]).toBeLessThan(HONOLULU[0]);
    expect(bounds[1][0]).toBeGreaterThan(HONOLULU[0]);
    await expect(window.locator(".photo-map-marker").first()).toBeVisible({ timeout: 10_000 });
  });

  test("moving the map looks around; closing it brings the place back", async () => {
    await window.evaluate(() => window.__afterframeMapTest.jumpTo([2.35, 48.85], 5));
    await expect(chip()).toHaveText("Visible map area", { timeout: 10_000 });
    // Still inside the memory's dates: nothing from Honolulu, nothing undated.
    await expect(cards()).toHaveCount(0, { timeout: 10_000 });

    await toggleMap(false);
    await expect(chip()).toHaveText("Honolulu", { timeout: 10_000 });
    await expect(cards()).toHaveCount(3, { timeout: 10_000 });

    // Opening it again frames the place again and keeps it.
    await toggleMap(true);
    await settle();
    await expect(chip()).toHaveText("Honolulu");
    await expect(cards()).toHaveCount(3);
    const { center } = await mapState();
    expect(Math.abs(center[0] - HONOLULU[0])).toBeLessThan(1);
  });
});

// The first time the map opens in a session, on a Discover place: the map is
// built and framed at once, before its zoom listener exists, and the level
// switcher stayed on World over a city-level view (0.5.8 review, F5).
test.describe("The map's first open, on a Discover place", () => {
  test.skip(!!process.env.CI, "no GPU/WebGL on the GitHub macOS runner: MapLibre never renders");
  let app, window, userDataDir, dir;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-first-map-")));
    const files = [];
    for (const day of ["02", "03", "04"]) {
      const file = await writeUniqueJpeg(path.join(dir, `waikiki-${day}.jpg`), { width: 320, height: 240 });
      files.push(tagPhoto(file, { taken: `2024:01:${day} 09:00:00`, gps: [21.2766, -157.8271] }));
    }
    ({ app, window, userDataDir } = await launchApp({ testName: "map-first-open" }));
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
    }, files);
    await window.locator(".app-toolbar button").first().click();
    await window.getByRole("button", { name: "Import", exact: true }).click();
    for (const file of files) await expect(window.locator(`[data-image-path='${file}']`)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => window.evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), { timeout: 30_000 }).toBe(false);
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("it opens framed on the place, with the City level lit", async () => {
    await window.getByRole("navigation").first().getByRole("button", { name: "Discover" }).click();
    await window.getByRole("button", { name: /^Honolulu/ }).first().click();
    await expect(window.locator("[data-testid='geo-filter-chip']")).toHaveText("Honolulu", { timeout: 10_000 });
    await window.locator("[data-testid='map-toggle']").click();
    await expect(window.locator(".photo-map-stage[data-map-ready='true']")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await window.evaluate(() => window.__afterframeMapTest.getState())).zoom, { timeout: 10_000 }).toBeGreaterThan(6);
    await expect(window.locator(".photo-map-stage")).toHaveAttribute("data-marker-mode", "detail");
    await expect(window.locator("[data-testid='geo-filter-chip']")).toHaveText("Honolulu");
  });
});
