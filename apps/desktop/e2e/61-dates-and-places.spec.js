// Dates as a user away from UTC reads them (America/Los_Angeles, where the
// 0.5.8 report was written), and a Discover memory — a place plus a run of
// days — in both languages.
//   - Imported / Modified are moments: shown in the viewer's zone. The import
//     stamp is SQLite's CURRENT_TIMESTAMP, UTC with no zone written; it used
//     to be read as local time and showed 7 hours late.
//   - Captured is the camera's own clock and is shown as written (#147).
//   - A memory's date range read "1月2日 – 2024年 (日: 6日)" in Chinese.
// Runs in CI: no map is opened here, so no WebGL is needed (23 covers the map).

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, byImagePath, importThroughToolbar } = require("./helpers/app");
const { tagPhotos, writeUniqueJpeg } = require("./helpers/images");

const ZONE = "America/Los_Angeles";
const HONOLULU = [21.3069, -157.8583];

let ctx, dir, files;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
// The Inspector's own format, computed in the renderer so it uses the app's
// locale data and zone.
const shown = (epochMs) => ctx.window.evaluate((ms) => new Date(ms).toLocaleString([], {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}), epochMs);

test.beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-dates-")));
  const photos = [];
  for (const day of ["02", "04", "06"]) {
    const file = await writeUniqueJpeg(path.join(dir, `honolulu-${day}.jpg`), { width: 320, height: 240 });
    photos.push({ file, taken: `2024:01:${day} 18:05:00`, gps: HONOLULU });
  }
  files = tagPhotos(photos);
  ctx = await launchApp({ testName: "dates-and-places", env: { TZ: ZONE } });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the app runs in the zone under test", async () => {
  // Without this, every assertion below would pass on a UTC machine for the
  // wrong reason.
  expect(await ctx.window.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(ZONE);
});

test("Imported and Modified are shown in the viewer's zone, Captured as the camera wrote it", async () => {
  await importThroughToolbar(ctx.app, ctx.window, files);
  const importedAround = Date.now();
  const card = ctx.window.locator(`[data-gallery-item='true']${byImagePath(files[0])}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(ctx.window.getByTestId("inspector-asset-title")).toHaveText("honolulu-02.jpg");

  // The camera's clock: 18:05 on Jan 2, whatever the viewer's zone.
  await expect(ctx.window.getByTestId("inspector-captured")).toHaveText(
    await ctx.window.evaluate(() => new Date(2024, 0, 2, 18, 5).toLocaleString([], {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })),
  );
  // Imported a moment ago, by the wall clock here — not 7 hours from now.
  const imported = await ctx.window.getByTestId("inspector-imported").innerText();
  const nearby = await Promise.all([-1, 0, 1, 2].map((minutes) => shown(importedAround + minutes * 60_000)));
  expect(nearby).toContain(imported);
  // The file's modification time, in the viewer's zone.
  await expect(ctx.window.getByTestId("inspector-modified")).toHaveText(await shown(fs.statSync(files[0]).mtimeMs));
});

test("a Discover memory names its days naturally in Chinese and English, and opens its place", async () => {
  const openDiscover = () => ctx.window.getByRole("navigation").first().getByRole("button", { name: /^(Discover|发现)$/ }).click();
  const memory = () => ctx.window.getByRole("button", { name: /^Honolulu/ });

  await ctx.window.evaluate(() => window.__afterframeTest.setLocale("zh-CN"));
  try {
    await openDiscover();
    await expect(memory()).toBeVisible({ timeout: 15_000 });
    await expect(memory()).toContainText("2024年1月2日–6日");
    await expect(memory()).not.toContainText("日:");
  } finally {
    await ctx.window.evaluate(() => window.__afterframeTest.setLocale("en"));
  }
  await openDiscover();
  await expect(memory()).toContainText(/Jan 2\s–\s6, 2024/);

  await memory().click();
  await expect(cards()).toHaveCount(3, { timeout: 10_000 });
  await expect(ctx.window.locator("[data-testid='geo-filter-chip']")).toHaveText("Honolulu");
  for (const file of files) await expect(ctx.window.locator(`[data-gallery-item='true']${byImagePath(file)}`)).toBeVisible();
});
