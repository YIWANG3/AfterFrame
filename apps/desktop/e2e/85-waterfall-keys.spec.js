// Arrow keys in the waterfall layout wrap at the edges like a line of text:
// Right in the last column goes on to the first column's next photo, Left in
// the first column goes back to the last column. They used to stop at the
// first or last column. The geometry rules are unit-tested in
// src/hooks/waterfallNavigation.test.js; this checks the real gallery.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;
test.beforeAll(async () => {
  ctx = await launchApp({ testName: "waterfall-keys" });
});
test.afterAll(async () => {
  await closeApp(ctx.app, ctx.userDataDir);
});

// Cards grouped into columns by their left edge, each column top to bottom.
async function columnsOnScreen(window) {
  const boxes = await galleryCards(window).evaluateAll((cards) => cards.map((card) => {
    const r = card.getBoundingClientRect();
    return { id: card.getAttribute("data-asset-id"), x: Math.round(r.left), y: Math.round(r.top) };
  }));
  const byX = new Map();
  for (const box of boxes) {
    const key = [...byX.keys()].find((x) => Math.abs(x - box.x) < 4) ?? box.x;
    if (!byX.has(key)) byX.set(key, []);
    byX.get(key).push(box);
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([, column]) => column.sort((a, b) => a.y - b.y));
}

const selectedId = (window) => window.locator("[data-gallery-item='true'][data-selected='true']").getAttribute("data-asset-id");
const card = (window, id) => window.locator(`[data-gallery-item='true'][data-asset-id="${id}"]`);

test("Left and Right wrap between the last and the first column", async () => {
  const { window } = ctx;
  await expect(galleryCards(window).first()).toBeVisible({ timeout: 15_000 });
  await window.getByTestId("display-mode-trigger").click();
  await window.getByTestId("display-mode-waterfall").click();

  let columns;
  await expect.poll(async () => {
    columns = await columnsOnScreen(window);
    return columns.length >= 2 && columns[0].length >= 2;
  }, { timeout: 10_000 }).toBe(true);
  const first = columns[0];
  const last = columns[columns.length - 1];

  // Left on the very first photo has nowhere to go.
  await card(window, first[0].id).click();
  await window.keyboard.press("ArrowLeft");
  await expect(card(window, first[0].id)).toHaveAttribute("data-selected", "true");

  // Right from the top of the last column: on to the first column, one line down.
  await card(window, last[0].id).click();
  await window.keyboard.press("ArrowRight");
  const wrappedTo = await selectedId(window);
  const firstIds = first.map((box) => box.id);
  expect(firstIds).toContain(wrappedTo);
  expect(firstIds.indexOf(wrappedTo)).toBeGreaterThanOrEqual(1);

  // And Left from there goes back up into the last column.
  await window.keyboard.press("ArrowLeft");
  const back = await selectedId(window);
  const lastBox = last.find((box) => box.id === back);
  expect(lastBox).toBeTruthy();
  expect(lastBox.y).toBeLessThan(first.find((box) => box.id === wrappedTo).y);
});
