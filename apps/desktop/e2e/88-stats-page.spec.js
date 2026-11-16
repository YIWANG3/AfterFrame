// The statistics page (docs/prototypes/stats-page.html): opened from the
// sidebar, it counts the library's cameras, lenses, exposure, culling and
// shooting days for a time range, and every number opens the gallery
// filtered to the photos it counts. The fixture catalog has 13 photos and a
// video; three photos carry EXIF from a Canon EOS 6D, a Canon EOS R6m2 and a
// Hasselblad 907X, all from 2018–2025.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;
const w = () => ctx.window;

async function openStats() {
  await w().getByTestId("sidebar-stats").click();
  await expect(w().getByTestId("stats-view")).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "stats-page" });
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("the page counts the library's photos, cameras and lenses", async () => {
  await openStats();
  await expect(w().getByRole("heading", { name: "Statistics", exact: true })).toBeVisible();
  await expect(w().getByTestId("stats-tile-photos")).toContainText("13");
  await expect(w().getByTestId("stats-tile-photos")).toContainText("1 video");

  const cameras = w().getByTestId("stats-cameras").locator("[data-camera]");
  await expect(cameras).toHaveCount(3);
  // EXIF's names, as people say them; the gallery filter keeps the EXIF model.
  await expect(w().locator('[data-camera="CFV 100C/907X"]')).toContainText("Hasselblad CFV 100C/907X");
  await expect(w().locator('[data-camera="Canon EOS 6D"]')).toContainText("EF24-105mm f/4L IS USM");
  await expect(w().getByTestId("stats-lenses").locator("[data-lens]")).toHaveCount(3);
  // The other ten photos have no camera in their EXIF, and say so.
  await expect(w().getByTestId("stats-cameras")).toContainText("10 photos don't say which camera took them.");

  // Gear comes first; the calendar sits below the exposure charts.
  const order = await w().locator("[data-stats-section]").evaluateAll((els) => els.map((el) => el.dataset.statsSection));
  expect(order.indexOf("gear")).toBeLessThan(order.indexOf("habits"));
  expect(order.indexOf("habits")).toBeLessThan(order.indexOf("rhythm"));

  // The Inspector has no photo to show here: the page takes its width.
  await expect(w().locator(".grid > aside")).toHaveCount(1);
});

test("a camera opens the gallery filtered to its photos", async () => {
  await openStats();
  await w().locator('[data-camera="Canon EOS 6D"]').click();
  await expect(w().getByTestId("stats-view")).toHaveCount(0);
  await expect(galleryCards(w())).toHaveCount(1, { timeout: 10_000 });
  // The filter is on the bar, where it can be seen and cleared.
  await expect(w().getByRole("button", { name: "Canon EOS 6D", exact: true })).toBeVisible();
  await expect(w().getByRole("button", { name: /^Clear 1$/ })).toBeVisible();
});

test("a day on the calendar opens that day", async () => {
  await openStats();
  await w().locator("[data-stats-year=\"2025\"]").click();
  const day = w().getByTestId("stats-calendar").locator('rect[data-day="2025-10-04"]');
  await expect(day).toHaveClass(/cursor-pointer/);
  await day.click();
  await expect(galleryCards(w())).toHaveCount(1, { timeout: 10_000 });
});

test("the time range narrows every number", async () => {
  await openStats();
  // Nothing in the fixture was taken this year.
  await w().locator('[data-stats-range="year"]').click();
  await expect(w().getByTestId("stats-empty")).toBeVisible({ timeout: 10_000 });
  // The choice is remembered, and All time brings the library back.
  await w().locator('[data-stats-range="all"]').click();
  await expect(w().getByTestId("stats-tile-photos")).toContainText("13");
});

test("a count opens as many cards as it says, the video included", async () => {
  await openStats();
  // The flag and rating filters match videos too, so the count does: the
  // fixture's unflagged, unrated video is among the "not looked at yet".
  const shown = Number((await w().getByTestId("stats-unreviewed-count").locator("div").first().innerText()).replace(/\D/g, ""));
  expect(shown).toBeGreaterThan(0);
  await w().getByTestId("stats-unreviewed-count").click();
  await expect(w().getByTestId("stats-view")).toHaveCount(0);
  await expect(galleryCards(w())).toHaveCount(shown, { timeout: 10_000 });
});
