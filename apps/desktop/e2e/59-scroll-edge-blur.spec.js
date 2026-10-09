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

// capturePage() copies the last frame the compositor drew. The page can be well
// ahead of it: on the CI VM the band's opacity already read 1 while the frame
// with the scroll was still rasterizing, so the "blurred" strip came from
// before the scroll (ratio 0.71, that stale frame's exact value). So after each
// change, paint a stamp in the sidebar's corner in a new colour, and capture the
// strip only once a capture shows that colour: frames only move forward, so the
// strip's frame has every change made before the stamp.
const STAMP_CHANNEL = { red: 0, blue: 2 };
async function captureAfterStamp(app, window, locator, colour) {
  await window.evaluate((background) => {
    let stamp = document.getElementById("edge-stamp");
    if (!stamp) {
      stamp = document.createElement("div");
      stamp.id = "edge-stamp";
      stamp.style.cssText = "position:fixed;left:24px;bottom:24px;width:8px;height:8px;z-index:2147483647;pointer-events:none";
      document.body.append(stamp);
    }
    stamp.style.background = background;
  }, colour);
  await expect.poll(async () => {
    const png = await captureElement(app, window, window.locator("#edge-stamp"));
    const { channels } = await sharp(png).stats();
    return channels.slice(0, 3).every(({ mean }, i) => (i === STAMP_CHANNEL[colour] ? mean > 150 : mean < 100));
  }, { timeout: 10_000 }).toBe(true);
  return captureElement(app, window, locator);
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

    const blurred = await detail(await captureAfterStamp(app, window, probe, "red"));
    await window.evaluate((css) => {
      const style = document.createElement("style");
      style.id = "edge-no-blur";
      style.textContent = css;
      document.head.append(style);
    }, NO_BLUR);
    const sharpOnly = await detail(await captureAfterStamp(app, window, probe, "blue"));
    await window.evaluate(() => {
      document.getElementById("edge-no-blur").remove();
      document.getElementById("edge-stamp").remove();
    });

    expect(sharpOnly).toBeGreaterThan(1);
    expect(blurred / sharpOnly).toBeLessThan(0.5);
  });
});
