// The drag-select box starts where the pointer went down. Points used to be
// measured from the scroller, whose padding the box and the layout boxes sit
// inside, so the box started a padding away from the pointer: 8 px left and,
// under the floating toolbar's 60 px top padding, 60 px up.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;
test.beforeAll(async () => {
  ctx = await launchApp({ testName: "marquee-origin" });
});
test.afterAll(async () => {
  await closeApp(ctx.app, ctx.userDataDir);
});

test("the drag-select box starts at the pointer and ends at it", async () => {
  const { window } = ctx;
  await expect(galleryCards(window).first()).toBeVisible({ timeout: 15_000 });
  const firstCard = await galleryCards(window).first().boundingBox();

  // Start in the gap just above the first card (below the toolbar), so no card
  // takes the pointerdown, and end inside the first card.
  const start = { x: firstCard.x + 4, y: firstCard.y - 4 };
  const end = { x: firstCard.x + firstCard.width / 2, y: firstCard.y + firstCard.height / 2 };
  await window.mouse.move(start.x, start.y);
  await window.mouse.down();
  await window.mouse.move(end.x, end.y, { steps: 8 });

  const box = await window.getByTestId("gallery-marquee").boundingBox();
  expect(Math.abs(box.x - start.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - start.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x + box.width - end.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - end.y)).toBeLessThanOrEqual(1);
  await window.mouse.up();

  await expect(galleryCards(window).first()).toHaveAttribute("data-selected", "true");
});
