// The photo's details, beside it in the lightbox.
//
// I (or the Info button) brings out a pane on the right: the grid's inspector,
// less what the lightbox already shows (the preview) or what leads to another
// photo, and with what was shot before what was written. The photo makes room
// rather than being covered, the pane follows the photo, what is set in it is
// the photo's, and in or out is remembered. It is dark whatever the theme.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;
const w = () => ctx.window;
const viewport = () => w().locator("[data-lightbox-viewport='true']");
const photo = () => viewport().locator("[data-lightbox-layer='preview']");
const pane = () => w().getByTestId("lightbox-info");
const toggle = () => w().getByTestId("lightbox-info-toggle");
const paneTitle = () => pane().getByTestId("inspector-asset-title");
const headerTitle = () => w().locator("[data-layer='lightbox'] .text-\\[15px\\]").first();
// Section headings in order; a heading's badge (a tag count, "AI") is a child element and is left out.
const sections = () => pane().locator("span.uppercase.font-semibold.text-muted2").evaluateAll((els) => els.map((el) => el.firstChild?.textContent?.trim()));
const edges = async (locator) => {
  const box = await locator.boundingBox();
  return { left: box.x, right: box.x + box.width, width: box.width };
};

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "lightbox-details" });
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
  await galleryCards(w()).first().dblclick();
  await expect(photo()).toBeVisible({ timeout: 10_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("I brings the details out beside the photo, which makes room", async () => {
  await expect(pane()).toHaveCount(0);
  await expect(toggle()).toHaveAttribute("aria-pressed", "false");
  const before = await edges(viewport());

  await w().keyboard.press("i");
  await expect(pane()).toBeVisible();
  await expect(toggle()).toHaveAttribute("aria-pressed", "true");
  await expect(paneTitle()).toHaveText((await headerTitle().textContent()).trim());

  // The stage ends where the pane begins, and the photo is fitted to it again.
  const paneBox = await edges(pane());
  await expect.poll(async () => (await edges(viewport())).right).toBeLessThanOrEqual(paneBox.left + 1);
  expect((await edges(viewport())).width).toBeLessThan(before.width - 200);
  await expect.poll(async () => (await edges(photo())).right).toBeLessThanOrEqual(paneBox.left + 1);
  // So do the bars: the close button is not under the pane.
  expect((await edges(toggle())).right).toBeLessThan(paneBox.left);
});

test("it is the inspector, less what the lightbox shows already or what leads elsewhere", async () => {
  const names = await sections();
  expect(names.slice(0, 2)).toEqual(["Properties", "Camera"]);
  expect(names).toContain("Dates");
  expect(names.indexOf("Dates")).toBeLessThan(names.indexOf("Tags"));
  for (const gone of ["Source", "People", "Duplicates", "Similar", "AI analysis"]) expect(names).not.toContain(gone);
  await expect(pane().getByTestId("inspector-rating")).toBeVisible();
  await expect(pane().getByTestId("inspector-captured")).toBeVisible();
  await expect(pane().getByTestId("inspector-tags")).toHaveCount(1);
  await expect(pane().locator("img")).toHaveCount(0);
  await expect(pane().getByTestId("inspector-palette")).toHaveCount(0);
  await expect(pane().getByTestId("inspector-source-path")).toHaveCount(0);
});

test("it follows the photo", async () => {
  const first = (await paneTitle().textContent()).trim();
  await w().keyboard.press("ArrowRight");
  await expect(paneTitle()).not.toHaveText(first);
  await expect(paneTitle()).toHaveText((await headerTitle().textContent()).trim());
  await w().keyboard.press("ArrowLeft");
  await expect(paneTitle()).toHaveText(first);
});

test("what is set there is the photo's, and typing there is typing", async () => {
  await pane().getByTestId("inspector-rating").locator("button").nth(3).click();
  await expect(pane().getByTestId("inspector-rating")).toHaveAttribute("data-value", "4");
  await expect(w().getByTestId("lightbox-marks").locator("svg")).toHaveCount(4);
  // The culling keys still answer, and the pane shows what they set.
  await w().keyboard.press("2");
  await expect(pane().getByTestId("inspector-rating")).toHaveAttribute("data-value", "2");
  await w().keyboard.press("0");

  // p, x and the space bar are a flag, a flag and "close" anywhere else.
  await pane().getByTestId("tag-add").click();
  await pane().getByTestId("tag-add-input").pressSequentially("p x box");
  await pane().getByTestId("tag-add-input").press("Enter");
  await expect(pane().locator("[data-tag='p x box']")).toBeVisible();
  await expect(pane()).toBeVisible();
  await expect(pane().getByTestId("inspector-flag")).toHaveAttribute("data-value", "none");
});

test("it is dark in the light theme too", async () => {
  const colors = () => pane().evaluate((el) => {
    const title = el.querySelector("[data-testid='inspector-asset-title']");
    return { text: getComputedStyle(title).color, scheme: getComputedStyle(el).colorScheme };
  });
  const dark = await colors();
  await w().evaluate(() => { document.documentElement.dataset.theme = "light"; });
  expect(await colors()).toEqual(dark);
  expect(dark.scheme).toBe("dark");
  await w().evaluate(() => { delete document.documentElement.dataset.theme; });
});

test("proof puts it away; closed and opened again, the lightbox has it as it was left", async () => {
  await toggle().click();
  await expect(pane()).toHaveCount(0);
  await toggle().click();
  await expect(pane()).toBeVisible();

  await w().keyboard.press("ControlOrMeta+p");
  await expect(w().locator("[data-lightbox-proof='true']")).toBeVisible();
  await expect(pane()).toHaveCount(0);
  await w().keyboard.press("ControlOrMeta+p");
  await expect(pane()).toBeVisible();

  // A click in the pane is not a click on the backdrop.
  await paneTitle().click();
  await expect(pane()).toBeVisible();

  await w().keyboard.press("Escape");
  await expect(w().locator("[data-layer='lightbox']")).toHaveCount(0);
  await w().keyboard.press("Space");
  await expect(pane()).toBeVisible();

  await w().keyboard.press("i");
  await expect(pane()).toHaveCount(0);
  const stage = await edges(viewport());
  const windowWidth = await w().evaluate(() => window.innerWidth);
  expect(stage.right).toBeGreaterThan(windowWidth - 2);
});

test("a tag there shows that tag's photos, back in the grid", async () => {
  await w().keyboard.press("i");
  await pane().locator("[data-tag='p x box'] button").first().click();
  await expect(w().locator("[data-layer='lightbox']")).toHaveCount(0);
  await expect(galleryCards(w())).toHaveCount(1);
});
