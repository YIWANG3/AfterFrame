// Web-build smoke: the shared App on the browser bridge, end to end.
// Each test gets a fresh browser context (empty IndexedDB) from Playwright.
const { test, expect } = require("@playwright/test");

const FIXTURE = "/e2e/fixtures/real-images/IMG_0695-Enhanced-NR-3.jpg"; // Canon EOS 6D EXIF
const FIXTURE2 = "/e2e/fixtures/real-images/0Y1A6707-9.jpg";

// Drop files onto the gallery through the app's real drag-import path.
// Fetches from the dev server (which serves the repo fixtures) and dispatches
// a DataTransfer drop — same event flow as a user dragging files in.
async function dropFiles(page, urls, { names } = {}) {
  await page.evaluate(async ({ urls, names }) => {
    const dt = new DataTransfer();
    for (let i = 0; i < urls.length; i++) {
      const res = await fetch(urls[i]);
      if (!res.ok) throw new Error(`fixture fetch failed: ${urls[i]}`);
      const blob = await res.blob();
      const name = (names && names[i]) || urls[i].split("/").pop();
      const type = name.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
      dt.items.add(new File([blob], name, { type }));
    }
    const empty = Array.from(document.querySelectorAll("div")).find((d) => d.textContent === "No assets in this view");
    const target = empty?.parentElement || document.querySelector("img")?.closest("button")?.parentElement || document.querySelector('img[alt="AfterFrame"]')?.closest("section");
    if (!target) throw new Error("no gallery drop target");
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, { urls, names });
}

function card(page, stem) {
  return page.locator(`img[alt="${stem}"]`).first();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/web.html");
  await expect(page.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
});

test("boots into a browser welcome page with locked desktop entries", async ({ page }) => {
  await expect(page.getByRole("button", { name: "New Catalog", exact: true })).toHaveCount(0);
  // Locked sidebar entries render but are inert (tooltip carries the hint).
  const stickers = page.getByRole("button", { name: /Stickers/ });
  await expect(stickers).toHaveAttribute("title", /desktop app/);
  // The one conversion surface.
  await expect(page.getByRole("button", { name: /Try the desktop app/ })).toBeVisible();
});

test("imports via drag-drop and reads EXIF into the Inspector", async ({ page }) => {
  await dropFiles(page, [FIXTURE]);
  const c = card(page, "IMG_0695-Enhanced-NR-3");
  await expect(c).toBeVisible({ timeout: 15_000 });
  await c.click();
  await expect(page.getByText("Canon EOS 6D")).toBeVisible();
  await expect(page.getByText("EF24-105mm f/4L IS USM")).toBeVisible();
  await expect(page.getByText("ISO 3200")).toBeVisible();
});

test("imported photos stay session-only and reset on reload", async ({ page }) => {
  await dropFiles(page, [FIXTURE]);
  await expect(card(page, "IMG_0695-Enhanced-NR-3")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
  await expect(card(page, "IMG_0695-Enhanced-NR-3")).toHaveCount(0);
});

test("editor opens, applies a text preset, saves as a browser download", async ({ page }) => {
  await dropFiles(page, [FIXTURE]);
  const c = card(page, "IMG_0695-Enhanced-NR-3");
  await expect(c).toBeVisible({ timeout: 15_000 });
  await c.click();
  await page.keyboard.press("e");
  await expect(page.getByTestId("tool-crop")).toBeVisible();
  // Sticker stays locked on the web bridge; AI repaint is BYOK-unlocked.
  await expect(page.getByRole("button", { name: /Sticker · This feature/ })).toBeVisible();
  await expect(page.getByTestId("tool-ai-repaint")).toBeVisible();
  await page.getByTestId("tool-text").click();
  // Scene depth is a desktop-only hint block.
  await expect(page.getByText("Scene Depth", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Dune/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/IMG_0695.*\.(jpg|jpeg|png)$/i);
});

test("two selected photos open the collage and export a download", async ({ page }) => {
  await dropFiles(page, [FIXTURE, FIXTURE2]);
  await expect(card(page, "0Y1A6707-9")).toBeVisible({ timeout: 20_000 });
  await card(page, "IMG_0695-Enhanced-NR-3").click();
  await card(page, "0Y1A6707-9").click({ modifiers: ["Meta"] });
  await card(page, "0Y1A6707-9").click({ button: "right" });
  await page.getByText("Collage", { exact: true }).click();
  await expect(page.getByText("COLLAGE", { exact: false }).first()).toBeVisible();
  // Both source images listed by their real filenames.
  await expect(page.getByTestId("collage-image-list").getByText("IMG_0695-Enhanced-NR-3.jpg")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/collage.*\.jpg$/i);
});

test("videos are rejected with a toast instead of silently dropped", async ({ page }) => {
  await dropFiles(page, [FIXTURE], { names: ["clip.mp4"] });
  await expect(page.getByText(/videos and RAW need the desktop app/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
});


test("sample library uses hosted previews without database storage", async ({ page }) => {
  await page.getByRole("button", { name: "Browse Sample Library" }).click();
  await expect(card(page, "sample-01")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "New Catalog", exact: true })).toHaveCount(0);
  await expect.poll(() => card(page, "sample-01").evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  expect(await card(page, "sample-01").getAttribute("src")).toMatch(/^http/);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
  await page.getByRole("button", { name: "Browse Sample Library" }).click();
  await expect(card(page, "sample-01")).toBeVisible();
});


test("oversized import batches are rejected before any image is added", async ({ page }) => {
  await dropFiles(page, Array(31).fill(FIXTURE));
  await expect(page.getByText(/up to 30 imported photos/)).toBeVisible();
  await expect(card(page, "IMG_0695-Enhanced-NR-3")).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});


test("byte limit rejects a batch without decoding originals", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const file = new File(["test"], "large.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 201 * 1024 * 1024 });
    const key = window.mediaWorkspace.getPathForFile(file);
    try { await window.mediaWorkspace.startImport({ imageDirs: [key] }); }
    catch (error) { return error.message; }
  });
  expect(result).toContain("200 MB");
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});


test("ignores macOS metadata companions during browser import", async ({ page }) => {
  await dropFiles(page, [FIXTURE, FIXTURE], { names: ["portrait.jpg", "._portrait.jpg"] });
  await expect(card(page, "portrait")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-gallery-item="true"]')).toHaveCount(1);
  await expect(card(page, "._portrait")).toHaveCount(0);
});
