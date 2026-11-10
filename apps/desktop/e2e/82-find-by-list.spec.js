// "Find by List…": a client answers the JPEGs they were sent with a list of
// numbers, in whatever shape a chat message takes. Pasted into the dialog,
// each number is looked up by file name in the place on screen, says what it
// found, and the photos go into a folder.
//
// The fixture's names: 001-red … 010-black, 0Y1A6707-9, B0016108,
// IMG_0695-Enhanced-NR-3 and a video.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;
const cards = () => galleryCards(ctx.window);
const cardStems = () => cards().evaluateAll((els) => els.map((el) => el.dataset.imagePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "")).sort());
const dialog = () => ctx.window.getByTestId("find-list-dialog");
const chip = (keyword) => dialog().locator(`[data-find-keyword='${keyword}']`);
const folders = () => ctx.window.evaluate(() => window.mediaWorkspace.listCollections());
const stemsIn = (name, includeDescendants = false) => ctx.window.evaluate(async ({ folder, deep }) => {
  const bridge = window.mediaWorkspace;
  const row = (await bridge.listCollections()).find((c) => c.name === folder);
  const rows = await bridge.browseCollection(row.collection_id, { limit: 100, includeDescendants: deep });
  return rows.map((r) => r.stem).sort();
}, { folder: name, deep: includeDescendants });

async function openDialog() {
  await ctx.window.getByTestId("find-list-open").click();
  await expect(dialog()).toBeVisible();
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "find-by-list" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a pasted list says what each number found, and the photos land in a new folder", async () => {
  await openDialog();
  await expect(ctx.window.getByTestId("find-list-place")).toHaveText("All Assets");
  // Nothing pasted, nothing to add.
  await expect(ctx.window.getByTestId("find-list-apply")).toBeDisabled();

  // A file name with its extension, a bar, a full-width comma, a sentence, a
  // number that is not there, a count and a word.
  await ctx.window.getByTestId("find-list-input").fill("这几张：B0016108.JPG 6707 | 0695，还有9999 和 001\n共12张 谢谢");
  await expect(dialog().locator("[data-find-keyword]")).toHaveCount(5);
  await expect(chip("B0016108")).toHaveAttribute("data-status", "one");
  await expect(chip("6707")).toHaveAttribute("data-status", "one");
  await expect(chip("0695")).toHaveAttribute("data-status", "one");
  await expect(chip("9999")).toHaveAttribute("data-status", "none");
  // 001-red, and B0016108 holds the same digits: both, and the chip says two.
  await expect(chip("001")).toHaveAttribute("data-status", "many");
  await expect(chip("001")).toContainText("2");
  await expect(chip("001")).toHaveAttribute("title", /001-red\.jpg/);
  // B0016108 is named twice and counted once.
  await expect(ctx.window.getByTestId("find-list-summary")).toContainText("4 photos found");
  await expect(ctx.window.getByTestId("find-list-summary")).toContainText("1 not found");

  // The client did not mean 001: out of the batch with a click.
  await chip("001").click();
  await expect(chip("001")).toHaveAttribute("data-status", "off");
  await expect(ctx.window.getByTestId("find-list-apply")).toHaveText("Add 3 Photos");

  await ctx.window.getByTestId("find-list-folder-name").fill("Picks");
  await ctx.window.getByTestId("find-list-apply").click();
  await expect(dialog()).toBeHidden();

  // The folder opens with the three photos.
  await expect(ctx.window.getByRole("button", { name: /^Picks/ })).toHaveClass(/bg-selected/, { timeout: 15_000 });
  await expect(cards()).toHaveCount(3);
  expect(await cardStems()).toEqual(["0Y1A6707-9", "B0016108", "IMG_0695-Enhanced-NR-3"]);
});

test("inside a folder the list is looked up in that folder, and a new folder is made inside it", async () => {
  await expect(ctx.window.getByRole("button", { name: /^Picks/ })).toHaveClass(/bg-selected/);
  await openDialog();
  await expect(ctx.window.getByTestId("find-list-place")).toHaveText("Picks");
  // 002-orange is in the library, not in this folder.
  await ctx.window.getByTestId("find-list-input").fill("002 6707");
  await expect(chip("002")).toHaveAttribute("data-status", "none");
  await expect(chip("6707")).toHaveAttribute("data-status", "one");
  await ctx.window.getByTestId("find-list-folder-name").fill("Final");
  await ctx.window.getByTestId("find-list-folder-name").press("Enter");
  await expect(dialog()).toBeHidden();

  await expect(cards()).toHaveCount(1);
  expect(await cardStems()).toEqual(["0Y1A6707-9"]);
  const all = await folders();
  const picks = all.find((c) => c.name === "Picks");
  expect(all.find((c) => c.name === "Final").parent_collection_id).toBe(picks.collection_id);
});

test("the photos can go into a folder that already exists", async () => {
  await ctx.window.getByRole("button", { name: /^All Assets/ }).first().click();
  await expect(cards().first()).toBeVisible();
  await openDialog();
  await ctx.window.getByTestId("find-list-input").fill("002-orange.jpg、010");
  await expect(chip("002")).toHaveAttribute("data-status", "one");
  await expect(chip("010")).toHaveAttribute("data-status", "one");
  const picks = (await folders()).find((c) => c.name === "Picks");
  await ctx.window.getByTestId("find-list-folder").selectOption(picks.collection_id);
  // An existing folder has its name already.
  await expect(ctx.window.getByTestId("find-list-folder-name")).toHaveCount(0);
  await ctx.window.getByTestId("find-list-apply").click();
  await expect(dialog()).toBeHidden();

  expect(await stemsIn("Picks")).toEqual(["002-orange", "010-black", "0Y1A6707-9", "B0016108", "IMG_0695-Enhanced-NR-3"]);
  expect(await stemsIn("Final")).toEqual(["0Y1A6707-9"]);
});

test("Escape closes the dialog and changes nothing", async () => {
  const before = (await folders()).length;
  await openDialog();
  // (Adding to Picks opened it: 002-orange is there now, 003-yellow is not.)
  await ctx.window.getByTestId("find-list-input").fill("002 003");
  await expect(chip("002")).toHaveAttribute("data-status", "one");
  await expect(chip("003")).toHaveAttribute("data-status", "none");
  await ctx.window.keyboard.press("Escape");
  await expect(dialog()).toBeHidden();
  expect((await folders()).length).toBe(before);
});

test("the list can filter the grid instead, and its chip opens it again as a plain list", async () => {
  await ctx.window.getByRole("button", { name: /^All Assets/ }).first().click();
  await expect(cards()).toHaveCount(14);
  // Something typed in the search box: the list takes its place.
  await ctx.window.getByPlaceholder("Search").fill("red");
  await expect(cards()).toHaveCount(1);

  await openDialog();
  await ctx.window.getByTestId("find-list-input").fill("这几张：B0016108.JPG 6707 | 9999");
  await expect(chip("9999")).toHaveAttribute("data-status", "none");
  await expect(ctx.window.getByTestId("find-list-summary")).toContainText("2 photos found");
  await ctx.window.getByTestId("find-list-filter").click();
  await expect(dialog()).toBeHidden();

  // The grid shows the two photos; no folder was made.
  await expect(cards()).toHaveCount(2);
  expect(await cardStems()).toEqual(["0Y1A6707-9", "B0016108"]);
  await expect(ctx.window.getByPlaceholder("Search")).toHaveValue("");
  const filterChip = ctx.window.getByTestId("name-filter-chip");
  // First on the bar: a long row of facets must not scroll it out of sight.
  await expect(filterChip).toBeInViewport();
  await expect(filterChip).toContainText("B0016108 +1");
  expect((await folders()).map((c) => c.name).sort()).toEqual(["Final", "Picks"]);

  // The chip opens the list again, as the keywords that found photos.
  await filterChip.getByRole("button").first().click();
  await expect(ctx.window.getByTestId("find-list-input")).toHaveValue("B0016108, 6707");
  await ctx.window.getByTestId("find-list-input").fill("B0016108, 6707, 0695");
  await expect(chip("0695")).toHaveAttribute("data-status", "one");
  await ctx.window.getByTestId("find-list-filter").click();
  await expect(cards()).toHaveCount(3);
  await expect(filterChip).toContainText("B0016108 +2");

  // Going somewhere else leaves the list behind, as it does any refinement.
  await ctx.window.getByRole("button", { name: /^Final/ }).click();
  await expect(cards()).toHaveCount(1);
  await expect(filterChip).toHaveCount(0);

  // Back in the library, the cross takes the list off.
  await ctx.window.getByRole("button", { name: /^All Assets/ }).first().click();
  await openDialog();
  await ctx.window.getByTestId("find-list-input").fill("001-red 002");
  await ctx.window.getByTestId("find-list-filter").click();
  await expect(cards()).toHaveCount(3);
  await ctx.window.getByTestId("name-filter-clear").click();
  await expect(filterChip).toHaveCount(0);
  await expect(cards()).toHaveCount(14);
});
