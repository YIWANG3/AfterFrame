// The lightbox's pin (#290).
//
// Unpinned, which is how it starts, the photo has the whole lightbox and the
// bars (the header, the zoom row with the filmstrip, the arrows) stay out of
// sight until the pointer comes near one of them; back on the photo they go
// again, and hidden bars drop focus and stay out of the Tab order. The arrow
// keys page either way. Pinned, the bars just stay out, over the photo: the
// pin moves the photo neither fitted nor zoomed, with the details out or not.
// The photo makes room for the details in both modes, and a zoomed photo goes
// on under them in both. The pin is remembered across a reopen and a restart.

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
// The photo's box as laid out, its transform included.
const rect = () => photo().evaluate((image) => {
  const r = image.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
// Whether the photo is under a point: hit testing skips what the stage clips.
const photoAt = (x, y) => w().evaluate(([px, py]) => document.elementsFromPoint(px, py)
  .some((el) => el.matches("[data-lightbox-layer='preview']")), [x, y]);
const nextFrame = () => w().evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const loaded = () => expect.poll(() => photo().evaluate((image) => image.complete && image.naturalWidth > 0 && !!image.style.width)).toBe(true);
const setPinned = async (on) => {
  if ((await pin().getAttribute("aria-pressed")) === String(on)) return;
  await clickLightboxControl(w(), pin());
  await expect(pin()).toHaveAttribute("aria-pressed", String(on));
  await nextFrame();
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

test("unpinned, opening the details refits the photo beside them", async () => {
  // The paging above leaves a photo that may not be loaded and fitted yet (an
  // unloaded one has no size, so it "fits" trivially); read it once it is.
  await loaded();
  await fitsStage();
  const fullStage = await box(viewport());
  await w().keyboard.press("i");
  await expect(pane()).toBeVisible();
  await hidden();
  const stage = await box(viewport());
  expect(stage.right).toBeCloseTo((await box(pane())).left, 0);
  expect(stage.width).toBeLessThan(fullStage.width);
  expect(stage.height).toBe(fullStage.height);
  await fitsStage();
  const fitted = await box(photo());
  expect(fitted.left + fitted.width / 2).toBeCloseTo(stage.left + stage.width / 2, 0);

  const ground = await pane().evaluate((el) => {
    const style = getComputedStyle(el);
    return { alpha: Number(style.backgroundColor.match(/[\d.]+(?=\))/)?.[0] ?? 1), blur: style.backdropFilter };
  });
  expect(ground.alpha).toBeGreaterThan(0.7);
  expect(ground.blur).toContain("blur");
  await w().keyboard.press("i");
  await expect(pane()).toHaveCount(0);
  expect(await box(viewport())).toEqual(fullStage);
  const restored = await box(photo());
  expect(restored.left + restored.width / 2).toBeCloseTo(fullStage.left + fullStage.width / 2, 0);
});

test("a clicked control keeps no focus, a focused one loses it when the bars hide, and Tab skips them", async () => {
  const reset = w().getByTitle("Reset to fit");
  await clickLightboxControl(w(), reset);
  // A click leaves no focus behind (ui/pointerFocus.js, docs/focus-design.md).
  await expect(reset).not.toBeFocused();

  // Focus that did not come from the pointer stays, until the bars hide.
  await reset.focus();
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

test("with the details out, the pin moves the photo neither fitted nor zoomed, and a zoomed photo goes on under them", async () => {
  await loaded();
  await w().keyboard.press("i");
  await expect(pane()).toBeVisible();
  await fitsStage();
  const stage = await box(viewport());
  const fitted = await rect();

  await setPinned(true);
  await expect(lightbox(w())).not.toHaveAttribute("data-lightbox-floating");
  expect(await box(viewport())).toEqual(stage);
  expect(await rect()).toEqual(fitted);
  await setPinned(false);
  expect(await rect()).toEqual(fitted);

  // Zoomed in about the middle until the photo runs well past the pane's edge.
  const paneBox = await box(pane());
  const midY = stage.top + stage.height / 2;
  for (let i = 0; i < 6 && (await rect()).left + (await rect()).width < paneBox.left + 80; i += 1) {
    await viewport().dispatchEvent("wheel", { deltaY: -100, clientX: stage.left + stage.width / 2, clientY: midY });
    await nextFrame();
  }
  const zoomed = await rect();
  expect(zoomed.left + zoomed.width).toBeGreaterThan(paneBox.left + 80);
  // Unpinned the photo goes on under the pane, as it does pinned.
  expect(await photoAt(paneBox.left + 40, midY)).toBe(true);

  await setPinned(true);
  expect(await rect()).toEqual(zoomed);
  expect(await photoAt(paneBox.left + 40, midY)).toBe(true);
  await setPinned(false);
  expect(await rect()).toEqual(zoomed);

  await clickLightboxControl(w(), w().getByTitle("Reset to fit"));
  await expect.poll(rect).toEqual(fitted);
  await toCenter();
  await w().keyboard.press("i");
  await expect(pane()).toHaveCount(0);
});

test("pinned, the bars stay out over the photo, which keeps its place; the pin is remembered", async () => {
  await loaded();
  await nextFrame();
  const fullStage = await box(viewport());
  const unpinned = await rect();
  await clickLightboxControl(w(), pin());
  await expect(pin()).toHaveAttribute("aria-pressed", "true");
  await expect(pin()).not.toBeFocused();
  await expect(lightbox(w())).not.toHaveAttribute("data-lightbox-floating");
  await nextFrame();
  expect(await box(viewport())).toEqual(fullStage);
  expect(await rect()).toEqual(unpinned);
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

  // Unpinned again, the photo stays where it was.
  await loaded();
  await fitsStage();
  await nextFrame();
  const pinnedStage = await box(viewport());
  const pinned = await rect();
  const f = await frame();
  expect(pinnedStage.top).toBeLessThanOrEqual(f.top + 1);
  expect(pinnedStage.height).toBeGreaterThanOrEqual(f.height - 1);
  await pin().click();
  await expect(pin()).toHaveAttribute("aria-pressed", "false");
  await nextFrame();
  expect(await box(viewport())).toEqual(pinnedStage);
  expect(await rect()).toEqual(pinned);
  await fitsStage();
});
