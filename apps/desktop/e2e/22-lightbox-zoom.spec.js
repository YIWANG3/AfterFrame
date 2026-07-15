const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Lightbox progressive zoom", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "lightbox-zoom" }));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("uses the 512px preview for zoom but keeps detail visible while panning", async () => {
    const card = window.locator("[data-gallery-item='true']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.dblclick();

    const viewport = window.locator("[data-lightbox-viewport='true']");
    const preview = viewport.locator("[data-lightbox-layer='preview']");
    await expect(preview).toBeVisible({ timeout: 5_000 });
    await expect(preview).toHaveAttribute("src", /\/previews\//);

    const detail = viewport.locator("[data-lightbox-layer='detail']");
    await expect(detail).toHaveCount(1);
    await expect(detail).toHaveCSS("visibility", "visible", { timeout: 5_000 });

    const initialTransform = await preview.evaluate((image) => image.style.transform);
    await viewport.dispatchEvent("wheel", { deltaY: -100, clientX: 500, clientY: 350 });
    await expect.poll(() => preview.evaluate((image) => image.style.transform)).not.toBe(initialTransform);

    await viewport.dispatchEvent("wheel", { deltaY: -20, clientX: 500, clientY: 350 });
    await expect(detail).toHaveCSS("visibility", "hidden");
    await expect(detail).toHaveCSS("visibility", "visible", { timeout: 5_000 });

    const detailTransformBeforePan = await detail.evaluate((image) => image.style.transform);
    const box = await viewport.boundingBox();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40);
    await expect(detail).toHaveCSS("visibility", "visible");
    await expect.poll(() => detail.evaluate((image) => image.style.transform)).not.toBe(detailTransformBeforePan);
    await window.mouse.up();

    await window.getByTitle(/reset to fit/i).click();
    await expect(detail).toHaveCSS("visibility", "visible", { timeout: 5_000 });
  });
});
