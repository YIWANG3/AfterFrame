const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");
const { captureElement } = require("./helpers/screenshot");

// What scrolls under the toolbar is blurred by the band on the split's
// ::before. A clip-path on the content pane stopped that backdrop-filter from
// sampling the gallery (0.5.8): the band still dimmed, so the captions under
// the toolbar stayed perfectly legible and nothing looked broken at a glance.
// Capture the same strip with the band's backdrop-filter on and off. The tint
// is identical in both, so only the blur can take the detail out.
const NO_BLUR = '[data-testid="workspace-split"]::before { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';

// Mean absolute difference between neighbouring pixels: high for sharp text and
// edges, low once they are blurred.
async function detail(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let sum = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = y * width + x;
      sum += Math.abs(data[i] - data[i - 1]) + Math.abs(data[i] - data[i - width]);
    }
  }
  return sum / (width * height);
}

test.describe("Scroll edge", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "scroll-edge-blur" }));
    // Narrow enough for three columns, so the 14-photo fixture scrolls.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 720));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("captions scrolled under the toolbar are blurred", async () => {
    await expect(window.locator("[data-gallery-item='true'] img").first()).toBeVisible({ timeout: 10_000 });
    // Off-screen thumbnails load lazily, so only wait for the ones on screen.
    await expect.poll(() => window.evaluate(() =>
      [...document.querySelectorAll("[data-gallery-item='true'] img")]
        .filter((img) => img.getBoundingClientRect().top < innerHeight)
        .every((img) => img.complete)), { timeout: 10_000 }).toBe(true);

    // Put the first row's captions just below the toolbar, where the band is
    // close to full strength, and mark that strip with an invisible probe.
    await window.evaluate(() => {
      const pane = document.querySelector(".noise-overlay > .grid > section.bg-app");
      const scroller = document.querySelector('[data-testid="gallery-scroll"]');
      const img = document.querySelector("[data-gallery-item='true'] img");
      scroller.scrollTop += img.getBoundingClientRect().bottom - (pane.getBoundingClientRect().top + 52);
      const probe = document.createElement("div");
      probe.dataset.testid = "edge-probe";
      probe.style.cssText = "position:absolute;top:56px;left:0;right:16px;height:32px;pointer-events:none";
      pane.append(probe);
    });
    await expect.poll(() => window.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="workspace-split"]'), "::before").opacity)).toBe("1");
    const probe = window.getByTestId("edge-probe");

    const blurred = await detail(await captureElement(app, window, probe));
    await window.evaluate((css) => {
      const style = document.createElement("style");
      style.id = "edge-no-blur";
      style.textContent = css;
      document.head.append(style);
    }, NO_BLUR);
    await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sharpOnly = await detail(await captureElement(app, window, probe));
    await window.evaluate(() => document.getElementById("edge-no-blur").remove());

    expect(sharpOnly).toBeGreaterThan(1);
    expect(blurred / sharpOnly).toBeLessThan(0.5);
  });
});
