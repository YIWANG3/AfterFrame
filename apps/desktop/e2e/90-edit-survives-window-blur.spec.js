// Switching to another app in the middle of typing doesn't end the edit: a
// description or a folder name being typed stays open with its draft and
// nothing is saved. Back in the app, Enter still saves and Escape still
// discards; a click elsewhere in the app still saves, as before.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

test.describe.configure({ mode: "serial" });

let ctx;
const w = () => ctx.window;
const card = (id) => w().locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
const rows = () => w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 500 }));
const descriptionOf = async (id) => (await rows()).find((row) => row.asset_id === id)?.description ?? null;
const folderNames = () => w().evaluate(() => window.mediaWorkspace.listCollections().then((all) => all.map((c) => c.name)));

// Playwright tells the page it always has focus, so on its own a window losing
// focus would look like a blur inside the page. Switching away turns that off
// and takes focus from the window, as the OS does when the user picks another
// app. Coming back gives it focus again and turns it back on, so the test
// doesn't hang on whether macOS lets a background app take focus.
let cdp;
const focusEmulation = (enabled) => cdp.send("Emulation.setFocusEmulationEnabled", { enabled });
async function switchAway() {
  await focusEmulation(false);
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
  // The page hears of it a moment later, longer on a slow machine; what
  // follows only means something once it has.
  await expect.poll(() => w().evaluate(() => document.hasFocus())).toBe(false);
}
async function comeBack() {
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await focusEmulation(true);
}

// Selects a photo and waits for the Inspector to show it (it keeps the last
// photo's detail until the new one arrives).
async function show(row) {
  await card(row.asset_id).click();
  await expect(w().getByTestId("inspector-asset-title")).toHaveText(row.image_path.split(/[\\/]/).pop());
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "edit-window-blur" });
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
  cdp = await w().context().newCDPSession(w());
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a description being typed survives switching apps; Enter saves it, Escape drops it", async () => {
  const bare = (await rows()).filter((row) => row.asset_type === "image" && !row.description);
  expect(bare.length).toBeGreaterThanOrEqual(3);
  const description = w().getByTestId("inspector-description");
  const input = w().getByTestId("description-input");

  // Typed, then the window loses focus: still open, still the draft, unsaved.
  await show(bare[0]);
  await description.getByTestId("description-add").click();
  await input.fill("Half a sent");
  await switchAway();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Half a sent");
  expect(await descriptionOf(bare[0].asset_id)).toBeNull();
  // Back in the app the field still has the caret: typing goes on, Enter saves.
  await comeBack();
  await expect(input).toBeFocused();
  await input.press("End");
  await w().keyboard.type("ence");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(description).toHaveAttribute("data-source", "user");
  await expect.poll(() => descriptionOf(bare[0].asset_id)).toBe("Half a sentence");

  // Escape after a switch away still discards.
  await show(bare[1]);
  await description.getByTestId("description-add").click();
  await input.fill("not this");
  await switchAway();
  await expect(input).toHaveValue("not this");
  await comeBack();
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(description.getByTestId("description-add")).toBeVisible();
  expect(await descriptionOf(bare[1].asset_id)).toBeNull();

  // A click elsewhere in the app still saves and closes, as before.
  await show(bare[2]);
  await description.getByTestId("description-add").click();
  await input.fill("saved by a click");
  await w().getByTestId("inspector-asset-title").click();
  await expect(input).toHaveCount(0);
  await expect.poll(() => descriptionOf(bare[2].asset_id)).toBe("saved by a click");
});

test("a folder name being typed survives switching apps", async () => {
  const field = () => w().getByTestId("sidebar-folder-scroll").locator("input");

  await w().getByTitle("New collection", { exact: true }).click();
  await field().fill("Trip to");
  await switchAway();
  await expect(field()).toBeVisible();
  await expect(field()).toHaveValue("Trip to");
  expect(await folderNames()).not.toContain("Trip to");
  await comeBack();
  await expect(field()).toBeFocused();
  await field().press("End");
  await w().keyboard.type(" Kyoto");
  await field().press("Enter");
  await expect(field()).toHaveCount(0);
  await expect.poll(folderNames).toContain("Trip to Kyoto");
  expect(await folderNames()).not.toContain("Trip to");

  // A click elsewhere still commits the name.
  await w().getByTitle("New collection", { exact: true }).click();
  await field().fill("Clicked away");
  await galleryCards(w()).first().click();
  await expect(field()).toHaveCount(0);
  await expect.poll(folderNames).toContain("Clicked away");
});
