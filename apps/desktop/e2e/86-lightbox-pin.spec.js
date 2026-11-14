// The lightbox's pin (#290).
//
// Unpinned, which is how it starts, the photo has the whole window and the
// bars (the header, the zoom row with the filmstrip, the arrows) stay out of
// sight until the pointer comes near one of them; back on the photo they go
// again, and the arrow keys page either way. The details float over the photo
// rather than moving it. Pinned, the bars stay out and the photo is fitted
// between them, as before the pin. The choice is remembered across a reopen
// and a restart.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, galleryCards } = require("./helpers/app");
const { lightbox, revealLightboxControl, clickLightboxControl } = require("./helpers/lightbox");

let ctx;
const w = () => ctx.window;
const viewport = () => w().locator("[data-lightbox-viewport='true']");
const photo = () => viewport().locator("[data-lightbox-layer='preview']");
const header = () => w().locator("[data-layer='lightbox'] > div[data-lightbox-control='true']");
const zoomRow = () => w().locator("[data-layer='lightbox'] > div[data-lightbox-control='bottom']").first();
const headerTitle = () => w().locator("[data-layer='lightbox'] .text-\\[15px\\]").first();
const pin = () => w().getByRole("button", { name: "Pin preview controls" });
const pane = () => w().getByTestId("lightbox-info");
const box = async (locator) => {
  const b = await locator.boundingBox();
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width, width: b.width, height: b.height };
};
const windowSize = () => w().evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
const hidden = () => expect(lightbox(w())).toHaveAttribute("data-lightbox-controls-hidden", "true");
const shown = () => expect(lightbox(w())).not.toHaveAttribute("data-lightbox-controls-hidden");
const toCenter = async () => {
  const size = await windowSize();
  await w().mouse.move(size.width / 2, size.height / 2);
};
// The fitted photo lies inside the stage.
const fitsStage = async () => {
  const stage = await box(viewport());
  await expect.poll(async () => {
    const p = await box(photo());
    return p.top >= stage.top - 1 && p.bottom <= stage.bottom + 1 && p.left >= stage.left - 1 && p.right <= stage.right + 1;
  }).toBe(true);
};

async function openLightbox() {
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
  await galleryCards(w()).first().dblclick();
  await expect(photo()).toBeVisible({ timeout: 10_000 });
  await toCenter();
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "lightbox-pin" });
  await openLightbox();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("unpinned at first: the photo has the whole window and the bars are out of sight", async () => {
  await expect(pin()).toHaveAttribute("aria-pressed", "false");
  await expect(lightbox(w())).toHaveAttribute("data-lightbox-floating", "true");
  await hidden();
  await expect(header()).toHaveCSS("opacity", "0");

  const size = await windowSize();
  const stage = await box(viewport());
  expect(stage.top).toBeLessThanOrEqual(1);
  expect(stage.height).toBeGreaterThanOrEqual(size.height - 1);
  await fitsStage();
});

test("the pointer at a bar or an arrow brings the bars out; back on the photo they go", async () => {
  const size = await windowSize();
  await w().mouse.move(size.width / 2, 12);
  await shown();
  await expect(header()).toHaveCSS("opacity", "1");
  await toCenter();
  await hidden();

  await w().mouse.move(size.width / 2, size.height - 12);
  await shown();
  await expect(zoomRow()).toHaveCSS("opacity", "1");
  await toCenter();
  await hidden();

  await revealLightboxControl(w(), w().getByRole("button", { name: "Next item" }));
  await toCenter();
  await hidden();
});

test("the arrow keys page while the bars are hidden", async () => {
  const first = (await headerTitle().textContent()).trim();
  await w().keyboard.press("ArrowRight");
  await expect(headerTitle()).not.toHaveText(first);
  await hidden();
  await w().keyboard.press("ArrowLeft");
  await expect(headerTitle()).toHaveText(first);
});

test("unpinned, the details float over the photo and leave it where it was", async () => {
  const stage = await box(viewport());
  const transform = await photo().evaluate((image) => image.style.transform);
  await w().keyboard.press("i");
  await expect(pane()).toBeVisible();
  expect((await box(viewport())).width).toBe(stage.width);
  expect(await photo().evaluate((image) => image.style.transform)).toBe(transform);
  await w().keyboard.press("i");
  await expect(pane()).toHaveCount(0);
});

test("pinned, the bars stay out and the photo is fitted between them; the pin is remembered", async () => {
  const fullStage = await box(viewport());
  await clickLightboxControl(w(), pin());
  await expect(pin()).toHaveAttribute("aria-pressed", "true");
  await expect(lightbox(w())).not.toHaveAttribute("data-lightbox-floating");
  const stage = await box(viewport());
  expect(stage.top).toBeGreaterThan(fullStage.top + 40);
  expect(stage.height).toBeLessThan(fullStage.height - 100);
  await fitsStage();

  // Back on the photo, the bars stay.
  await toCenter();
  await w().waitForTimeout(600);
  await shown();
  await expect(header()).toHaveCSS("opacity", "1");

  // Closed and opened again.
  await w().keyboard.press("Escape");
  await expect(lightbox(w())).toHaveCount(0);
  await w().keyboard.press("Space");
  await expect(photo()).toBeVisible();
  await expect(pin()).toHaveAttribute("aria-pressed", "true");

  // And after a restart.
  await collectCoverage(ctx.app); // the restart path bypasses closeApp
  await ctx.app.close();
  ctx = { ...ctx, ...(await launchApp({ testName: "lightbox-pin", reuseUserDataDir: ctx.userDataDir, keepCatalog: true })) };
  await openLightbox();
  await expect(pin()).toHaveAttribute("aria-pressed", "true");
  await expect(lightbox(w())).not.toHaveAttribute("data-lightbox-floating");

  // Unpinned again, the photo is fitted to the whole window.
  await pin().click();
  await expect(pin()).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await box(viewport())).height).toBeGreaterThan(stage.height + 100);
  await fitsStage();
});
