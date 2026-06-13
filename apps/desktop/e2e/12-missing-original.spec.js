// Missing-original handling (block A): detection, gallery badge, inspector
// banner + relink, and the editor block when an original has moved/deleted.
//
// Safety: the seeded catalog points at the committed real-image fixtures, which
// we must NOT delete. So we relink one asset to a private tmp COPY, delete the
// copy to simulate a moved/deleted original, then relink back — the committed
// fixture is never touched.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Missing original handling", () => {
  let app, window, userDataDir;
  let assetId, committedPath, tmpCopy;

  const cardById = () =>
    window.locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`);

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "missing" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });

    // Find the framed-portrait asset (B0016108) and its on-disk original.
    const info = await window.evaluate(async () => {
      const rows = await window.mediaWorkspace.browseExports({ status: "all", limit: 50 });
      const r = rows.find((x) => x.stem === "B0016108");
      return r ? { assetId: r.asset_id, exportPath: r.export_path } : null;
    });
    expect(info, "B0016108 should be in the seeded catalog").toBeTruthy();
    assetId = info.assetId;
    committedPath = info.exportPath;

    // Relink to a tmp copy (same bytes → fingerprint matches, no force needed).
    tmpCopy = path.join(os.tmpdir(), `af-missing-${Date.now()}-B0016108.jpg`);
    fs.copyFileSync(committedPath, tmpCopy);
    const relinked = await window.evaluate(
      ({ id, newPath }) => window.mediaWorkspace.relinkAsset({ assetId: id, newPath }),
      { id: assetId, newPath: tmpCopy },
    );
    expect(relinked.status).toBe("relinked");

    // Now delete the copy → the original is "missing", and run the explicit
    // verify sweep (File ▸ Verify Files), then refresh the gallery.
    fs.rmSync(tmpCopy, { force: true });
    const sweep = await window.evaluate(() => window.mediaWorkspace.verifyAssets());
    expect(sweep.missing).toBeGreaterThanOrEqual(1);
    await window.evaluate(() => window.__afterframeTest.refresh());
  });

  test.afterAll(async () => {
    fs.rmSync(tmpCopy, { force: true });
    await closeApp(app, userDataDir);
  });

  test("gallery card shows the Missing badge", async () => {
    await expect(
      cardById().locator('[title="Original file moved or deleted"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("inspector shows the missing banner with a Relink button", async () => {
    await cardById().click();
    await expect(window.getByText(/Original file moved or deleted/i)).toBeVisible({ timeout: 5_000 });
    await expect(window.getByRole("button", { name: /^Relink$/i })).toBeVisible();
    // The Source row carries a "Missing" tag next to the struck-through path.
    await expect(window.getByText(/^Missing$/).first()).toBeVisible();
  });

  test("opening the editor is blocked with a toast", async () => {
    await cardById().click();
    await window.keyboard.press("e");
    await expect(window.getByText(/Original file missing/i)).toBeVisible({ timeout: 5_000 });
    expect(await window.evaluate(() => window.__afterframeTest.getEditorOpen())).toBe(false);
  });

  test("relinking restores the asset and preserves its rating", async () => {
    const restored = await window.evaluate(
      ({ id, newPath }) => window.mediaWorkspace.relinkAsset({ assetId: id, newPath }),
      { id: assetId, newPath: committedPath },
    );
    expect(restored.status).toBe("relinked");
    await window.evaluate(() => window.__afterframeTest.refresh());

    await expect(cardById().getByText(/Missing/i)).toHaveCount(0, { timeout: 10_000 });
    // B0016108 carries a 5-star XMP rating; relink must not have disturbed it.
    const rating = await window.evaluate(async (id) => {
      const rows = await window.mediaWorkspace.browseExports({ status: "all", limit: 50 });
      return rows.find((r) => r.asset_id === id)?.app_rating;
    }, assetId);
    expect(rating).toBe(5);
  });
});
