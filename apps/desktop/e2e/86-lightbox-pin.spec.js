// The lightbox's pin (#290).
//
// Unpinned, which is how it starts, the photo has the whole lightbox and the
// bars (the header, the zoom row with the filmstrip, the arrows) stay out of
// sight until the pointer comes near one of them; back on the photo they go
// again, and hidden bars drop focus and stay out of the Tab order. The arrow
// keys page either way. The details float over the photo. Pinned, the bars
// stay out and the photo is fitted between them. The choice is remembered
// across a reopen and a restart.

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
const pin = () => w().getByRole("button", { name: "Pin preview controls", includeHidden: true });
const pane = () => w().getByTestId("lightbox-info");
const box = async (locator) => {
  const b = await locator.boundingBox();
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width, width: b.width, height: b.height };
};
// The lightbox's own box: on Windows it starts under the app's 36px title
// bar (index.css, .fixed.inset-0 under html.platform-win32), so window
// coordinates are not its coordinates.
const frame = () => box(lightbox(w()));
const hidden = () => expect(lightbox(w())).toHaveAttribute("data-lightbox-controls-hidden", "true");
const shown = () => expect(lightbox(w())).not.toHaveAttribute("data-lightbox-controls-hidden");
const toCenter = async () => {
  const f = await frame();
  await w().mouse.move(f.left + f.width / 2, f.top + f.height / 2);
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

test("unpinned at first: the photo has the whole lightbox and the bars are out of sight", async () => {
  await expect(pin()).toHaveAttribute("aria-pressed", "false");
  await expect(lightbox(w())).toHaveAttribute("data-lightbox-floating", "true");
  await hidden();
  await expect(header()).toHaveCSS("opacity", "0");

  const f = await frame();
  const stage = await box(viewport());
  expect(stage.top).toBeLessThanOrEqual(f.top + 1);
  expect(stage.height).toBeGreaterThanOrEqual(f.height - 1);
  await fitsStage();
});

test("the pointer at a bar or an arrow brings the bars out; back on the photo they go", async () => {
  const f = await frame();
  await w().mouse.move(f.left + f.width / 2, f.top + 12);
  await shown();
  await expect(header()).toHaveCSS("opacity", "1");
  await toCenter();
  await hidden();

  await w().mouse.move(f.left + f.width / 2, f.bottom - 12);
  await shown();
  await expect(zoomRow()).toHaveCSS("opacity", "1");
  await toCenter();
  await hidden();

  await revealLightboxControl(w(), w().getByRole("button", { name: "Next item", includeHidden: true }));
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
  // The paging above leaves a photo that may not be loaded and fitted yet (an
  // unloaded one has no size, so it "fits" trivially); read it once it is.
  await expect.poll(() => photo().evaluate((image) => image.complete && image.naturalWidth > 0 && !!image.style.width)).toBe(true);
  await fitsStage();
  const stage = await box(viewport());
  const transform = await photo().evaluate((image) => image.style.transform);
  await w().keyboard.press("i");
  await expect(pane()).toBeVisible();
  expect((await box(viewport())).width).toBe(stage.width);
  expect(await photo().evaluate((image) => image.style.transform)).toBe(transform);
  // Over the photo, the pane has a dark, blurred ground of its own, so its text
  // reads on a bright sky too.
  const ground = await pane().evaluate((el) => {
    const style = getComputedStyle(el);
    return { alpha: Number(style.backgroundColor.match(/[\d.]+(?=\))/)?.[0] ?? 1), blur: style.backdropFilter };
  });
  expect(ground.alpha).toBeGreaterThan(0.7);
  expect(ground.blur).toContain("blur");
  await w().keyboard.press("i");
  await expect(pane()).toHaveCount(0);
});

test("a clicked control loses focus when the bars hide and Tab skips them", async () => {
  const reset = w().getByTitle("Reset to fit");
  await clickLightboxControl(w(), reset);
  await expect(reset).toBeFocused();

  await toCenter();
  await expect(reset).not.toBeFocused();
  await expect(zoomRow()).toHaveCSS("opacity", "0");

  const first = (await headerTitle().textContent()).trim();
  await w().keyboard.press("ArrowRight");
  await expect(headerTitle()).not.toHaveText(first);
  await expect(header()).toHaveCSS("opacity", "0");
  await w().keyboard.press("ArrowLeft");
  await expect(headerTitle()).toHaveText(first);

  await w().keyboard.press("Tab");
  await expect(lightbox(w()).locator("[data-lightbox-control]:focus-within")).toHaveCount(0);
  await expect(header()).toHaveCSS("opacity", "0");
  await expect(zoomRow()).toHaveCSS("opacity", "0");
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

  // Unpinned again, the photo is fitted to the whole lightbox.
  await pin().click();
  await expect(pin()).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await box(viewport())).height).toBeGreaterThan(stage.height + 100);
  await fitsStage();
});
