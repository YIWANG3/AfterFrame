// Smart collections v2, driven through the real filter bar: any facet can be
// excluded ("not this camera", "not in this folder"), ratings go below as well
// as above (and "unrated"), and conditions can be grouped so that any one
// group may hold. Every expected number is asked of the catalog.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;
let folderId;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const bar = () => ctx.window.locator("[data-filter-bar]");
const dialog = () => ctx.window.locator("[data-filter-groups-dialog]");
const option = (value) => ctx.window.locator(`[data-facet-option="${value}"]`);
const browseLength = (filters) => ctx.window.evaluate(
  (f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length),
  filters,
);
const collection = (name) => ctx.window.evaluate(
  (n) => window.mediaWorkspace.listCollections().then((rows) => rows.find((row) => row.name === n)),
  name,
);
async function saveAsSmart(name) {
  await ctx.window.getByRole("button", { name: "Save as smart collection" }).click();
  const input = ctx.window.locator("[data-smart-name-input] input");
  await input.fill(name);
  await input.press("Enter");
  await expect(ctx.window.locator("[data-smart-collection]").filter({ hasText: name })).toHaveClass(/bg-selected/);
  return collection(name);
}
async function backToLibrary() {
  await ctx.window.getByRole("button", { name: /^All Assets/ }).click();
  const clear = ctx.window.getByRole("button", { name: /^Clear/ });
  if (await clear.count()) await clear.click();
}

const CANON = "Canon EOS R6m2";

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "smart-collections-v2" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  // A folder holding two photos, and ratings pinned so "unrated" is known.
  folderId = await ctx.window.evaluate(async () => {
    const bridge = window.mediaWorkspace;
    const rows = (await bridge.browseImages({ status: "all", limit: 100, sort: "name-asc" })).filter((r) => r.asset_type !== "video");
    await bridge.createCollection("Published");
    const folder = (await bridge.listCollections()).find((c) => c.name === "Published");
    await bridge.collectionAddItems(folder.collection_id, rows.slice(0, 2).map((r) => r.asset_id));
    await bridge.setAssetRating(rows.slice(0, 3).map((r) => r.asset_id), 5);
    await bridge.setAssetRating(rows.slice(3, 5).map((r) => r.asset_id), 2);
    await bridge.setAssetRating(rows.slice(5).map((r) => r.asset_id), 0);
    return folder.collection_id;
  });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a camera can be excluded, and a photo with no camera is not that camera either", async () => {
  await bar().getByRole("button", { name: "Camera", exact: true }).click();
  await option(CANON).click();
  await expect(cards()).toHaveCount(await browseLength({ camera: CANON }));
  await ctx.window.locator("[data-facet-mode='exclude']").click();
  await ctx.window.keyboard.press("Escape");

  const notCanon = await browseLength({ camera: CANON, exclude: "camera" });
  expect(notCanon).toBe((await browseLength({})) - (await browseLength({ camera: CANON })));
  await expect(cards()).toHaveCount(notCanon);
  const chip = bar().getByRole("button", { name: `Camera is not ${CANON}` });
  await expect(chip).toHaveAttribute("data-excluded", "true");
  // One condition, flipped: still one.
  await expect(ctx.window.getByRole("button", { name: /^Clear 1$/ })).toBeVisible();

  // Unticking the camera takes "exclude" with it.
  await chip.click();
  await ctx.window.getByRole("button", { name: "Any Camera" }).click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(await browseLength({}));
  await expect(ctx.window.getByRole("button", { name: /^Clear/ })).toHaveCount(0);
});

test("not in a folder saves as a smart collection that follows the folder", async () => {
  await bar().getByRole("button", { name: "Folder", exact: true }).click();
  await option(folderId).click();
  await ctx.window.locator("[data-facet-mode='exclude']").click();
  await ctx.window.keyboard.press("Escape");
  await expect(bar().getByRole("button", { name: "Not in Published" })).toBeVisible();
  const expected = await browseLength({ in_collection: folderId, exclude: "in_collection" });
  expect(expected).toBe((await browseLength({})) - 2);
  await expect(cards()).toHaveCount(expected);

  const saved = await saveAsSmart("Not published");
  expect(saved.rules.filters).toEqual({ in_collection: folderId, exclude: "in_collection" });
  expect(saved.item_count).toBe(expected);
  await expect(cards()).toHaveCount(expected);

  // Adding a photo to the folder takes it out of the collection.
  const moved = await cards().first().getAttribute("data-asset-id");
  await ctx.window.evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folderId, asset: moved });
  await expect.poll(async () => (await collection("Not published")).item_count).toBe(expected - 1);
  await backToLibrary();
});

test("ratings: unrated, exactly and at most", async () => {
  const rating = bar().locator("[data-facet-rating]");
  await rating.locator("[data-rating-unrated]").click();
  await expect(cards()).toHaveCount(await browseLength({ rating_max: 0 }));

  // At least 2 → exactly 2 → at most 2.
  await rating.getByTitle("Rating ≥ 2").click();
  await expect(rating.locator("[data-rating-unrated]")).toHaveAttribute("aria-pressed", "false");
  await expect(cards()).toHaveCount(await browseLength({ rating_min: 2 }));
  await rating.locator("[data-rating-mode-toggle]").click();
  await expect(rating).toHaveAttribute("data-rating-mode", "eq");
  await expect(cards()).toHaveCount(await browseLength({ rating_min: 2, rating_max: 2 }));
  await rating.locator("[data-rating-mode-toggle]").click();
  await expect(rating).toHaveAttribute("data-rating-mode", "le");
  const atMostTwo = await browseLength({ rating_max: 2 });
  expect(atMostTwo).toBe((await browseLength({ rating_max: 0 })) + (await browseLength({ rating_min: 2, rating_max: 2 })));
  await expect(cards()).toHaveCount(atMostTwo);

  const saved = await saveAsSmart("Two stars or fewer");
  expect(saved.rules.filters).toEqual({ rating_max: 2 });
  expect(saved.item_count).toBe(atMostTwo);
  await backToLibrary();
});

test("condition groups: any one of them may hold, and they save with the collection", async () => {
  // The CI runner's window size: a lower group's lists must open on-screen
  // (they once opened below the window's bottom edge there).
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
  await bar().getByRole("button", { name: "Add filter" }).click();
  await ctx.window.locator("[data-filter-groups-entry]").click();
  await expect(dialog()).toBeVisible();
  const group = (n) => dialog().locator(`[data-filter-group-index="${n}"]`);

  // Group 1: shot on the Canon.
  await group(0).getByRole("button", { name: "Add condition" }).click();
  await ctx.window.locator("[data-facet-slot='camera']").click();
  await ctx.window.keyboard.press("Escape");
  await group(0).getByRole("button", { name: "Camera", exact: true }).click();
  await option(CANON).click();
  await ctx.window.keyboard.press("Escape");
  // Group 2: unrated.
  await group(1).getByRole("button", { name: "Add condition" }).click();
  await ctx.window.locator("[data-facet-slot='rating']").click();
  await ctx.window.keyboard.press("Escape");
  await group(1).locator("[data-rating-unrated]").click();
  await dialog().locator("[data-filter-groups-apply]").click();
  await expect(dialog()).toHaveCount(0);

  const groups = [{ camera: CANON }, { rating_max: 0 }];
  const either = await browseLength({ any_of: groups });
  expect(either).toBeGreaterThan(await browseLength({ camera: CANON }));
  await expect(cards()).toHaveCount(either);
  await expect(bar().getByRole("button", { name: "Any of 2 groups" })).toBeVisible();

  // The groups sit under the bar's own conditions: add a format on top.
  await bar().getByRole("button", { name: "Format", exact: true }).click();
  await option("JPG").click();
  await ctx.window.keyboard.press("Escape");
  const narrowed = await browseLength({ extension: "jpg", any_of: groups });
  await expect(cards()).toHaveCount(narrowed);

  const saved = await saveAsSmart("Canon or unrated JPGs");
  expect(saved.rules.filters).toEqual({ extension: "JPG", any_of: groups });
  expect(saved.item_count).toBe(narrowed);

  // Editing the collection brings the groups back into the dialog.
  const row = ctx.window.locator("[data-smart-collection]").filter({ hasText: "Canon or unrated JPGs" });
  await row.hover();
  await row.getByTitle("Edit conditions").click();
  await bar().getByRole("button", { name: "Any of 2 groups" }).click();
  await expect(dialog().locator("[data-filter-group-index]")).toHaveCount(2);
  await expect(dialog().locator("[data-filter-group-index='0']").getByRole("button", { name: CANON })).toBeVisible();
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await ctx.window.getByRole("button", { name: "Cancel", exact: true }).click();
  await backToLibrary();
});

test("an agent can exclude, cap the rating and group conditions", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  const notInFolder = await tool("search_assets", { collection_id: folderId, exclude: ["collection_id"], limit: 200 });
  expect(notInFolder.count).toBe(await browseLength({ in_collection: folderId, exclude: "in_collection" }));
  const grouped = await tool("search_assets", { any_of: [{ camera: CANON }, { rating_max: 0 }], limit: 200 });
  expect(grouped.count).toBe(await browseLength({ any_of: [{ camera: CANON }, { rating_max: 0 }] }));

  await tool("manage_collections", {
    action: "create", name: "Agent: not Canon, rated",
    rules: { camera: CANON, exclude: ["camera"], rating_min: 1 },
  });
  const listed = await collection("Agent: not Canon, rated");
  expect(listed.rules.filters).toEqual({ camera: CANON, exclude: "camera", rating_min: 1 });
  expect(listed.item_count).toBe(await browseLength({ camera: CANON, exclude: "camera", rating_min: 1 }));
});
