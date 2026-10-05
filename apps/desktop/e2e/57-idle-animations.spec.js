const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

// An infinite CSS animation anywhere on screen makes Chromium composite every
// frame for as long as the window is visible. The loading pulse under each
// gallery thumbnail used to keep running after the image loaded: invisible,
// but ~35% CPU in the GPU process with the app just sitting there.
test.describe("Idle app", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "idle-animations" }));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("a loaded gallery runs no endless animations on screen", async () => {
    const cards = window.locator("[data-gallery-item='true']");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    // Only the thumbnails in view. Cards up to 600 px below the fold already
    // have their <img>, but it is loading="lazy" and won't load until scrolled
    // to: in the CI VM's 1024×681 window most of the 14 never do.
    await expect.poll(() => window.evaluate(() => {
      const bottom = document.querySelector('[data-testid="gallery-scroll"]').getBoundingClientRect().bottom;
      const imgs = [...document.querySelectorAll("[data-gallery-item='true'] img")]
        .filter((img) => img.getBoundingClientRect().top < bottom);
      return imgs.length > 0 && imgs.every((img) => img.complete);
    }), { timeout: 10_000 }).toBe(true);

    const onScreenEndless = () => window.evaluate(() => document.getAnimations()
      .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations === Infinity)
      .filter((a) => {
        const r = a.effect.target?.getBoundingClientRect?.();
        return r && r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
      })
      .map((a) => `${a.animationName} on .${String(a.effect.target.className).split(" ").join(".")}`));
    await expect.poll(onScreenEndless, { timeout: 5_000 }).toEqual([]);
  });
});
