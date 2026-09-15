const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("GPS priority and collage menu", () => {
  let app, window, userDataDir, assetId;
  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({
      testName: "gps-location-menu",
      prepareCatalog(catalogDir) {
        // Seed a historic wrong annotation, not a mocked renderer response.
        assetId = execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), `
          CREATE TEMP TABLE target AS SELECT asset_id FROM assets WHERE asset_type = 'image' LIMIT 1;
          UPDATE assets SET metadata_json = json_set(COALESCE(metadata_json, '{}'),
            '$.gps_latitude', 20.8795, '$.gps_longitude', -156.6899)
            WHERE asset_id IN (SELECT asset_id FROM target);
          INSERT OR REPLACE INTO asset_ai_annotations
            (asset_id, provider, model, schema_version, caption, tags_json, location_json)
            SELECT asset_id, 'openai', 'test', 2, 'Landscape', '[]',
            '{"country":"United Kingdom","admin1":"Scotland","landmark":"Glen Coe","confidence":75}' FROM target;
          SELECT asset_id FROM target;
        `], { encoding: "utf8" }).trim();
      },
    }));
  });
  test.afterAll(async () => closeApp(app, userDataDir));

  test("historic guess is replaced by GPS on browse and detail reads", async () => {
    await window.locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`).click();
    await expect(window.getByTestId("annotation-gps-location")).toContainText("20.8795, -156.6899");
    await expect(window.getByText("Hawaii", { exact: true })).toBeVisible();
    await expect(window.getByText("United States", { exact: true })).toBeVisible();
    await expect(window.getByText("Glen Coe", { exact: true })).toHaveCount(0);
    await expect(window.getByText("United Kingdom", { exact: true })).toHaveCount(0);
    const detail = await window.evaluate((id) => window.mediaWorkspace.getAnnotation(id), assetId);
    expect(detail.location.source).toBe("exif");
    expect(detail.location.admin1).toBe("Hawaii");
    expect(detail.location.landmark).toBeNull();
    await expect(window.getByTitle("Clear location", { exact: true })).toHaveCount(0);
  });

  test("Replace hover stays clipped inside the rounded menu", async ({}, testInfo) => {
    const cards = window.locator("[data-gallery-item='true']");
    await cards.nth(0).click();
    await cards.nth(3).click({ modifiers: ["Shift"] });
    await cards.nth(0).click({ button: "right" });
    await window.getByText(/^Collage$/).click();
    const canvas = window.getByTestId("collage-canvas");
    await expect(canvas).toBeVisible();
    const bounds = await canvas.boundingBox();
    await canvas.click({ button: "right", position: { x: bounds.width / 4, y: bounds.height / 4 } });
    const menu = window.getByTestId("collage-cell-menu");
    const replace = menu.getByRole("button", { name: "Replace", exact: true });
    await replace.hover();
    await expect(menu).toHaveCSS("overflow-x", "hidden");
    await expect(menu).toHaveCSS("overflow-y", "hidden");
    expect(await menu.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0);
    const screenshotPath = testInfo.outputPath("replace-hover.png");
    await menu.screenshot({ path: screenshotPath });
    await testInfo.attach("replace-hover", { path: screenshotPath, contentType: "image/png" });
    await window.mouse.click(1, 1);
    await window.keyboard.press("Escape");
  });
});
