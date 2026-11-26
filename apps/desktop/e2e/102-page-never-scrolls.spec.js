// The window is transparent and #root paints the app's rounded panel, so the
// page under it must never scroll sideways: when it did, the whole app slid
// left inside the window and the desktop showed through on the right, as if
// the window had shrunk (2026-11-26).
//
// How it happened: #root is the containing block of the fixed layers (its
// will-change: transform, #323), so anything a layer lays out past the window
// widened the page. A big photo in the lightbox sits at its full size for a
// moment before it is fitted, and opening it there made the page scrollable
// just as the filmstrip centred the current thumbnail with scrollIntoView.
// With few photos the strip has nothing to scroll, so the page scrolled
// instead, by however far the thumbnail sat right of the window's middle.
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");
const { cloneAssets } = require("./helpers/clone-assets");

const BIG = Array.from({ length: 10 }, (_, i) => `zz-big-${String(i + 1).padStart(2, "0")}`);

let ctx;

test.beforeAll(async () => {
  // A 2400px photo, ten times.
  ctx = await launchApp({
    testName: "page-never-scrolls",
    prepareCatalog: (dir) => cloneAssets(dir, BIG, { source: "0Y1A6707-9" }),
  });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("opening a big photo at the right end of a short filmstrip leaves the app where it is", async () => {
  const { window } = ctx;
  // Only the ten: a filmstrip that fits the window with room to spare, so the
  // strip itself cannot scroll and its last thumbnails sit right of the middle.
  await window.getByPlaceholder("Search", { exact: true }).fill("zz-big");
  await expect(galleryCards(window)).toHaveCount(BIG.length);

  // Every scroll of the page itself, and #root's left edge on every frame.
  await window.evaluate(() => {
    const seen = { scrolls: [], rootLeft: 0 };
    window.__pageScroll = seen;
    document.addEventListener("scroll", (event) => {
      const target = event.target === document ? document.scrollingElement : event.target;
      if (target === document.body || target === document.documentElement) {
        seen.scrolls.push([target.tagName, target.scrollLeft, target.scrollTop]);
      }
    }, true);
    const sample = () => {
      seen.rootLeft = Math.min(seen.rootLeft, document.getElementById("root").getBoundingClientRect().left);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const viewport = window.locator("[data-lightbox-viewport='true']");
  const count = await galleryCards(window).count();
  for (const index of [count - 1, count - 2, count - 3]) {
    const card = galleryCards(window).nth(index);
    await expect(card).toHaveAttribute("data-asset-id", /^image_zz_big_/);
    await card.dblclick();
    await expect(viewport).toBeVisible();
    // The strip may be hidden until the pointer comes near; it is laid out
    // and centres its thumbnail all the same.
    await expect(window.locator("[data-lightbox-control='bottom'] [data-on='true']")).toHaveCount(1);
    // The full-size layer has replaced the preview, and the strip's smooth
    // scroll has had time to run.
    await expect(viewport.locator("[data-lightbox-layer='detail']")).toHaveCSS("visibility", "visible", { timeout: 10_000 });
    await window.waitForTimeout(600);

    const seen = await window.evaluate(() => window.__pageScroll);
    expect(seen.scrolls, `photo ${index + 1} of ${count} scrolled the page`).toEqual([]);
    expect(seen.rootLeft, `photo ${index + 1} of ${count} moved the app`).toBe(0);
    await expect.poll(() => window.evaluate(() => [document.body.scrollLeft, document.documentElement.scrollLeft])).toEqual([0, 0]);

    await window.keyboard.press("Escape");
    await expect(viewport).toHaveCount(0);
  }
});
