// Catalog-backed tests — uses the seeded fixture catalog (10 synthetic
// gradients + 3 real downscaled photographs).
// Verifies that the sidecar + IPC + Gallery rendering chain works end-to-end.

const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Catalog browse", () => {
  let app, window, userDataDir, catalogDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir, catalogDir } = await launchApp({ testName: "catalog" }));
    // Wait for the initial gallery query to settle
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("gallery shows the 14 seeded assets", async () => {
    // Wait for any gallery item to render — uses the data attribute set on
    // each card. If sidecar / browse-images / Gallery rendering is broken,
    // this fails fast.
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
    const count = await window.locator("[data-gallery-item='true']").count();
    // 10 synthetic gradients + 3 real photographs + 1 sample video (seed-catalog.js).
    expect(count).toBe(14);
  });

  test("filenames render in caption", async () => {
    // Synthetic fixtures are named 001-red.jpg through 010-black.jpg.
    // .first() because the inspector panel echoes the filename (caption +
    // heading + reveal-in-Finder path) for the active card.
    await expect(window.getByText(/001-red\.jpg/i).first()).toBeVisible();
    await expect(window.getByText(/010-black\.jpg/i).first()).toBeVisible();
    // Real photographs decode + render through the same preview pipeline.
    await expect(window.getByText(/B0016108\.jpg/i).first()).toBeVisible();
  });

  test("gallery card layout stays stable at default and larger window sizes", async () => {
    const sampleCardWidths = () => window.evaluate(async () => {
      const card = document.querySelector("[data-gallery-item='true']");
      const widths = [];
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        widths.push(card?.getBoundingClientRect().width ?? 0);
      }
      return widths;
    });
    const uniqueWidths = (widths) => new Set(widths.map((width) => width.toFixed(2)));

    const defaultWidths = await sampleCardWidths();
    expect([...uniqueWidths(defaultWidths)]).toHaveLength(1);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
    });
    await window.waitForTimeout(250);
    const largerWidths = await sampleCardWidths();
    expect([...uniqueWidths(largerWidths)]).toHaveLength(1);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 920);
    });
    await window.waitForTimeout(250);
  });

  test("single-click selects a card; selection ring appears on inner box", async () => {
    const firstCard = window.locator("[data-gallery-item='true']").first();
    await firstCard.click();
    // The selection ring is on an inner div (not the button itself).
    await expect(firstCard).toHaveAttribute("data-selected", "true");
  });

  test("context menu copies the file path and name to the clipboard", async () => {
    const firstCard = window.locator("[data-gallery-item='true']").first();
    await firstCard.click({ button: "right" });
    await window.getByText("Copy File Path", { exact: true }).click();
    const fullPath = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(fullPath).toMatch(/\.[a-z0-9]+$/i);
    expect(fullPath).toContain("/");

    await firstCard.click({ button: "right" });
    await window.getByText("Copy Name", { exact: true }).click();
    const name = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(name).not.toContain("/");
    expect(fullPath).toContain(name);
  });

  test("context menu refreshes one asset or the current multi-selection from disk", async () => {
    const cards = window.locator("[data-gallery-item='true']");
    const first = cards.nth(0);
    const second = cards.nth(1);

    await first.click();
    await first.click({ button: "right" });
    await expect(window.getByText("Refresh from Disk", { exact: true })).toBeVisible();
    await window.keyboard.press("Escape");

    await second.click({ modifiers: ["Meta"] });
    await second.click({ button: "right" });
    await window.getByText("Refresh 2 from Disk", { exact: true }).click();
    await expect(window.getByText("2 assets refreshed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(first).toHaveAttribute("data-selected", "true");
    await expect(second).toHaveAttribute("data-selected", "true");
  });

  test("Cmd+A selects every card in the gallery", async () => {
    // Click a card first so focus is in the gallery (not a text field).
    await window.locator("[data-gallery-item='true']").first().click();
    await window.keyboard.press("ControlOrMeta+a");
    const cards = window.locator("[data-gallery-item='true']");
    const count = await cards.count();
    expect(count).toBe(14);
    for (let i = 0; i < count; i += 1) {
      await expect(cards.nth(i)).toHaveAttribute("data-selected", "true");
    }
  });

  test("a missing or corrupt thumbnail regenerates on image load error", async () => {
    const card = window.locator("[data-gallery-item='true'][data-image-path$='/003-yellow.jpg']");
    const imagePath = await card.getAttribute("data-image-path");
    const detail = await window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), imagePath);
    const previewFile = detail?.preview_path || detail?.image_preview_path;
    fs.writeFileSync(previewFile, "");

    await card.locator("img").evaluate((img) => {
      img.dispatchEvent(new Event("error", { bubbles: true }));
    });
    await expect.poll(() => {
      try { return fs.statSync(previewFile).size; } catch { return 0; }
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(14);
  });

  // A valid-but-wrong preview (the decoder filled an early Lightroom export
  // with gray) does not emit <img onError>. Live source stat drift and missing
  // metadata must therefore self-heal as soon as the page is browsed.
  test("stale source state self-heals valid previews and missing metadata", async () => {
    const cards = window.locator("[data-gallery-item='true']");
    const firstPath = await cards.nth(0).getAttribute("data-image-path");
    const secondPath = await cards.nth(1).getAttribute("data-image-path");
    const [firstDetail, secondDetail] = await Promise.all([
      window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), firstPath),
      window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), secondPath),
    ]);
    const firstPreview = firstDetail?.preview_path || firstDetail?.image_preview_path;
    const secondPreview = secondDetail?.preview_path || secondDetail?.image_preview_path;
    expect(fs.existsSync(firstPreview)).toBe(true);
    expect(fs.existsSync(secondPreview)).toBe(true);

    // Keep the preview a valid JPEG but make it visibly/content-wise stale.
    fs.copyFileSync(secondPreview, firstPreview);
    const staleHash = crypto.createHash("sha256").update(fs.readFileSync(firstPreview)).digest("hex");

    // First asset: catalog stat no longer matches disk. Second asset: the
    // preview is good, but its dimensions/file-size metadata was never stored.
    execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), `
      UPDATE assets
      SET file_size = 0
      WHERE asset_id = '${firstDetail.asset_id}';
      UPDATE assets
      SET metadata_json = json_set(metadata_json, '$.width', NULL, '$.height', NULL, '$.file_size', 0)
      WHERE asset_id = '${secondDetail.asset_id}';
    `]);

    // Simulate reopening/browsing this page. The response exposes both stale
    // signals and Gallery batches them through refresh-assets automatically.
    await window.evaluate(() => window.__afterframeTest.refresh());
    await expect.poll(() => {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(firstPreview)).digest("hex");
      return hash;
    }, { timeout: 10_000 }).not.toBe(staleHash);
    await expect.poll(async () => {
      const rows = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 50 }));
      const second = rows.find((row) => row.asset_id === secondDetail.asset_id);
      return second?.image_metadata?.width || null;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(14);
  });

  // Keep this last: it mutates the (temp-copied) catalog.
  test("Delete opens the in-app confirm dialog and removes on confirm", async () => {
    await window.locator("[data-gallery-item='true']").first().click();
    await window.keyboard.press("Delete");
    // App-styled dialog, not the native one.
    await expect(window.getByText("Remove from catalog")).toBeVisible();

    // Cancel leaves the catalog untouched.
    await window.getByRole("button", { name: "Cancel" }).click();
    await expect(window.getByText("Remove from catalog")).toHaveCount(0);
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(14);

    // Confirm removes exactly the selected asset.
    await window.locator("[data-gallery-item='true']").first().click();
    await window.keyboard.press("Delete");
    await window.getByRole("button", { name: "Remove" }).click();
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(13);
  });
});
