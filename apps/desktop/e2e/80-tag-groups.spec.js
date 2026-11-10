// Tags by group (docs/tags-redesign.md): the fixture catalog (schema 12)
// gets its groups on open; the Inspector shows a photo's tags by group and
// folds a concept's two spellings into one; the Tags facet lists tags by
// group with "any tag of this group" and a by-group match; Shift+T takes
// tags off a selection; the Tags page makes groups and moves, merges,
// renames and pins tags; smart collections and agents use the groups; a
// restart keeps it all. One app, tests build in order.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, mcpCall, callToolOk, galleryCards } = require("./helpers/app");

test.describe.configure({ mode: "serial" });

let ctx;
let photos; // four image asset ids, name order
const cards = () => galleryCards(ctx.window);
const card = (id) => ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
const bar = () => ctx.window.locator("[data-filter-bar]");
const option = (value) => ctx.window.locator(`[data-facet-option="${value}"]`);
const bridge = (fn, arg) => ctx.window.evaluate(fn, arg);
const allAssets = () => ctx.window.getByRole("button", { name: /^All Assets/ }).click();
const browseLength = (filters) => bridge((f) => window.mediaWorkspace.browseImages({ status: "all", filters: f, limit: 1000 }).then((rows) => rows.length), filters);
const tagsOf = async (id) => (await bridge((assetId) => window.mediaWorkspace.getAssetTags(assetId), id)).tags;
const listed = () => bridge(() => window.mediaWorkspace.listTags({}));
const tagInfo = async (tag) => {
  const all = await listed();
  for (const group of all.groups) for (const entry of group.tags) if (entry.tag === tag) return { ...entry, group_id: group.group_id };
  const loose = all.ungrouped.find((entry) => entry.tag === tag);
  return loose ? { ...loose, group_id: null } : null;
};

async function restart() {
  await collectCoverage(ctx.app);
  await ctx.app.close();
  Object.assign(ctx, await launchApp({ testName: "tag-groups", reuseUserDataDir: ctx.userDataDir, keepCatalog: true }));
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "tag-groups" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  // Four untagged photos, in name order (the fixture tags two of its own).
  photos = await bridge(async () => (await window.mediaWorkspace.browseImages({ status: "all", limit: 100, sort: "name-asc" }))
    .filter((row) => row.asset_type === "image" && !(row.tags || []).length).slice(0, 4).map((row) => row.asset_id));
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("the catalog's tags got their groups when it was opened", async () => {
  const groups = await bridge(() => window.mediaWorkspace.listTagGroups());
  expect(groups.map((g) => g.group_id)).toEqual(["weather", "season", "time", "light", "subject", "place", "event", "gear", "technique", "style", "color", "mood", "workflow"]);
  expect(groups.find((g) => g.group_id === "workflow").ai_fill).toBe(0);
  // The fixture's "city" is a vocabulary word: place type. "seeded-tag" is nobody's.
  expect((await tagInfo("city")).group_id).toBe("place");
  expect((await tagInfo("city")).aliases).toEqual(["城市"]);
  expect((await tagInfo("seeded-tag")).group_id).toBeNull();
});

test("the Inspector shows tags by group; a concept's other spelling is the same tag; the picker places a new one", async () => {
  const id = photos[0];
  await card(id).click();
  const tags = ctx.window.getByTestId("inspector-tags");
  await expect(tags).toHaveAttribute("data-count", "0");

  await tags.getByTestId("tag-add").click();
  await tags.getByTestId("tag-add-input").fill("Sunset");
  await tags.getByTestId("tag-add-input").press("Enter");
  await expect(tags.locator("[data-tag-group='time'] [data-tag='sunset']")).toBeVisible();

  // 日落 is sunset: the photo keeps one chip.
  await tags.getByTestId("tag-add").click();
  await tags.getByTestId("tag-add-input").fill("日落");
  await tags.getByTestId("tag-add-input").press("Enter");
  await expect(tags).toHaveAttribute("data-count", "1");
  expect(await tagsOf(id)).toEqual(["sunset"]);

  // A tag the vocabulary does not know goes where the picker says.
  await tags.getByTestId("tag-add").click();
  await tags.getByTestId("tag-add-group").selectOption("mood");
  await tags.getByTestId("tag-add-input").fill("mochi");
  await tags.getByTestId("tag-add-input").press("Enter");
  await expect(tags.locator("[data-tag-group='mood'] [data-tag='mochi']")).toBeVisible();
  await expect(tags).toHaveAttribute("data-count", "2");
  expect((await tagInfo("mochi")).group_id).toBe("mood");

  // The chip's menu moves the tag for the whole library.
  await tags.locator("[data-tag='mochi']").click({ button: "right" });
  await ctx.window.locator("[data-tag-chip-move]").click();
  await ctx.window.locator("[data-tag-move-to='event']").click();
  await expect(tags.locator("[data-tag-group='event'] [data-tag='mochi']")).toBeVisible();
  expect((await tagInfo("mochi")).group_id).toBe("event");
});

test("the Tags facet lists tags by group, matches by group and by 'any tag of the group'", async () => {
  // A: sunny + street, B: cloudy + street, C: sunny, D: street + trip (ungrouped).
  await bridge(async (ids) => {
    const b = window.mediaWorkspace;
    await b.addAssetTags([ids[0]], ["sunny", "street"]);
    await b.addAssetTags([ids[1]], ["cloudy", "street"]);
    await b.addAssetTags([ids[2]], ["sunny"]);
    await b.addAssetTags([ids[3]], ["street", "trip"]);
  }, photos);
  // Written behind the app's back: Refresh re-asks the facet options.
  await ctx.window.getByTitle("Refresh").click();
  await ctx.window.getByRole("button", { name: "Filters" }).click();
  await expect(bar()).toHaveAttribute("data-facets-ready", "true");
  await expect.poll(async () => (await bridge(() => window.mediaWorkspace.getFacetValues({}))).tags.some((t) => t.value === "sunny")).toBe(true);
  await bar().getByRole("button", { name: "Tag", exact: true }).click();
  const popover = ctx.window.locator("[data-tag-facet]");
  await expect(popover.locator("[data-tag-facet-group='weather'] [data-facet-option='sunny']")).toBeVisible();
  await expect(popover.locator("[data-tag-facet-group='subject'] [data-facet-option='street']")).toBeVisible();
  await expect(popover.locator("[data-tag-facet-group='ungrouped'] [data-facet-option='trip']")).toBeVisible();

  // Searching matches the Chinese spelling too.
  await ctx.window.getByTestId("tag-facet-search").fill("晴");
  await expect(option("sunny")).toBeVisible();
  await expect(option("street")).toHaveCount(0);
  await ctx.window.getByTestId("tag-facet-search").fill("");

  await option("sunny").click();
  await option("cloudy").click();
  await option("street").click();
  await expect(cards()).toHaveCount(await browseLength({ tag: ["sunny", "cloudy", "street"] }));
  // (sunny OR cloudy) AND street: A and B.
  await ctx.window.locator("[data-facet-mode='by_group']").click();
  await expect(cards()).toHaveCount(2);
  expect(await browseLength({ tag: ["sunny", "cloudy", "street"], tag_match: "by_group" })).toBe(2);
  await ctx.window.locator("[data-facet-mode='any']").click();
  await expect(cards()).toHaveCount(await browseLength({ tag: ["sunny", "cloudy", "street"] }));
  await ctx.window.keyboard.press("Escape");
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();

  // The group's own tick: any weather tag at all.
  await bar().getByRole("button", { name: "Tag", exact: true }).click();
  await ctx.window.locator("[data-tag-group-option='weather']").click();
  await expect(cards()).toHaveCount(3);
  await ctx.window.keyboard.press("Escape");
  await expect(bar().getByRole("button", { name: "Any Weather tag" })).toBeVisible();
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();

  // The search box offers the tags the text matches; one click filters by it.
  const search = ctx.window.locator("[data-toolbar-search]");
  await search.fill("sun");
  await ctx.window.locator("[data-search-tag='sunny']").click();
  await expect(search).toHaveValue("");
  await expect(cards()).toHaveCount(2);
  await expect(bar().getByRole("button", { name: "sunny", exact: true })).toBeVisible();
  await ctx.window.getByRole("button", { name: /^Clear/ }).click();
});

test("Shift+T takes tags off every selected photo", async () => {
  await card(photos[0]).click();
  await card(photos[1]).click({ modifiers: ["ControlOrMeta"] });
  await ctx.window.keyboard.press("Shift+T");
  const dialog = ctx.window.getByTestId("tag-batch-dialog");
  await expect(dialog).toHaveAttribute("data-mode", "remove");
  const street = dialog.locator("[data-batch-present-tag='street']");
  await expect(street).toContainText("2");
  await street.click();
  await ctx.window.getByTestId("tag-batch-apply").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => [await tagsOf(photos[0]), await tagsOf(photos[1])]).toEqual([["sunset", "mochi", "sunny"], ["cloudy"]]);
  // The dialog switches to adding too.
  await ctx.window.keyboard.press("Shift+T");
  await dialog.locator("[data-tag-batch-mode='add']").click();
  await expect(dialog).toHaveAttribute("data-mode", "add");
  await ctx.window.keyboard.press("Escape");
});

test("the Tags page makes a group and moves, merges, renames and pins tags", async () => {
  await ctx.window.getByTestId("sidebar-tags").click();
  const page = ctx.window.getByTestId("tags-view");
  await expect(page).toBeVisible();
  await expect(page.locator("[data-tags-group='weather'] [data-tag-row='sunny']")).toBeVisible();

  // The toolbar shows the New Group label whole, clear of the sort dropdown
  // (a bare button in the toolbar is styled as a round icon button and clips it).
  const newGroup = ctx.window.getByTestId("tags-new-group");
  expect(await newGroup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const newGroupBox = await newGroup.boundingBox();
  const sortBox = await ctx.window.getByTestId("tags-sort").boundingBox();
  expect(newGroupBox.x + newGroupBox.width).toBeLessThanOrEqual(sortBox.x);

  // A new group, and trip moved into it from the row's menu.
  await newGroup.click();
  const nameBox = ctx.window.getByTestId("tags-new-group-input").locator("input");
  await nameBox.fill("Pets");
  await nameBox.press("Enter");
  const pets = await bridge(() => window.mediaWorkspace.listTagGroups().then((rows) => rows.find((g) => g.name === "Pets")));
  expect(pets.kind).toBe("custom");
  await expect(page.locator(`[data-tags-group='${pets.group_id}']`)).toContainText("Pets");
  await page.locator("[data-tag-row='trip']").hover();
  await page.locator("[data-tag-menu='trip']").click();
  await ctx.window.locator("[data-tag-menu-move]").click();
  await ctx.window.locator(`[data-tags-move-to='${pets.group_id}']`).click();
  await expect(page.locator(`[data-tags-group='${pets.group_id}'] [data-tag-row='trip']`)).toBeVisible();

  // cloudy merged into sunny: B carries sunny now, cloudy is an alias.
  await page.locator("[data-tag-select='sunny']").click();
  await page.locator("[data-tag-select='cloudy']").click();
  await ctx.window.getByTestId("tags-bulk-merge").click();
  const mergeBox = ctx.window.getByTestId("tags-merge-input");
  await mergeBox.fill("sunny");
  await mergeBox.press("Enter");
  await expect(page.locator("[data-tag-row='cloudy']")).toHaveCount(0);
  await expect.poll(() => tagsOf(photos[1])).toEqual(["sunny"]);
  // The merged tag's own alias (多云) follows it.
  expect((await tagInfo("sunny")).aliases.sort()).toEqual(["cloudy", "多云", "晴天"]);

  // Pinned, and renamed from the row's menu: the old name still resolves.
  await page.locator("[data-tag-row='street']").hover();
  await page.locator("[data-tag-pin='street']").click();
  await expect(page.locator("[data-tag-pin='street']")).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-tag-menu='street']").click();
  await ctx.window.locator("[data-tag-menu-rename]").click();
  const renameBox = page.locator("[data-tag-row='street'] input");
  await renameBox.fill("streets");
  await renameBox.press("Enter");
  await expect(page.locator("[data-tags-group='subject'] [data-tag-row='streets']")).toBeVisible();
  expect(await tagsOf(photos[3])).toEqual(["streets", "trip"]);
  expect((await tagInfo("streets")).pinned).toBe(true);

  // A tag's name opens the gallery filtered by it.
  await page.locator("[data-tag-open='sunny']").click();
  await expect(cards()).toHaveCount(3);
  await expect(bar().getByRole("button", { name: "sunny", exact: true })).toBeVisible();
});

test("a smart collection saves a group condition; an agent reads and edits the groups", async () => {
  await bar().getByRole("button", { name: "sunny", exact: true }).click();
  // sunny AND any time-of-day tag: only A (sunset).
  await ctx.window.locator("[data-tag-group-option='time']").click();
  await ctx.window.keyboard.press("Escape");
  await expect(cards()).toHaveCount(1);
  await ctx.window.getByRole("button", { name: "Save as smart collection" }).click();
  const nameInput = ctx.window.locator("[data-smart-name-input] input");
  await nameInput.fill("Sunny evenings");
  await nameInput.press("Enter");
  const saved = await bridge(() => window.mediaWorkspace.listCollections().then((rows) => rows.find((r) => r.name === "Sunny evenings")));
  expect(saved.rules.filters).toEqual({ tag: "sunny", tag_group: "time" });
  expect(saved.item_count).toBe(1);
  // Saving opens the collection; back to the whole library.
  await allAssets();

  const tags = await callToolOk(ctx.mcpPort, "list_tags", {});
  const subject = tags.groups.find((g) => g.group_id === "subject");
  expect(subject.tags.map((t) => t.tag)).toContain("streets");
  expect(tags.tags.find((t) => t.tag === "sunny").aliases).toContain("cloudy");
  const moved = await callToolOk(ctx.mcpPort, "manage_tags", { action: "move", tags: ["mochi"], group_id: "mood" });
  expect(moved).toEqual({ tags: ["mochi"], group_id: "mood" });
  await expect.poll(async () => (await tagInfo("mochi")).group_id).toBe("mood");
  const byGroup = await callToolOk(ctx.mcpPort, "search_assets", { tag_group: "weather", limit: 100 });
  expect(byGroup.count).toBe(3);
  // sunny (weather) AND sunset (time): A; any of them: A, B, C.
  const stacked = await callToolOk(ctx.mcpPort, "search_assets", { tag: ["sunny", "sunset"], tag_match: "by_group", limit: 100 });
  expect(stacked.count).toBe(1);
  const any = await callToolOk(ctx.mcpPort, "search_assets", { tag: ["sunny", "sunset"], limit: 100 });
  expect(any.count).toBe(3);
  const response = await mcpCall(ctx.mcpPort, "tools/call", { name: "manage_tags", arguments: { action: "delete", tag: "seeded-tag" } });
  expect(response.isError).toBeFalsy();
  expect(await tagInfo("seeded-tag")).toBeNull();
});

test("a restart keeps the groups, aliases, pins and the merge", async () => {
  await restart();
  const pets = await bridge(() => window.mediaWorkspace.listTagGroups().then((rows) => rows.find((g) => g.name === "Pets")));
  expect(pets).toBeTruthy();
  expect((await tagInfo("trip")).group_id).toBe(pets.group_id);
  // The merged tag's own alias (多云) follows it.
  expect((await tagInfo("sunny")).aliases.sort()).toEqual(["cloudy", "多云", "晴天"]);
  expect((await tagInfo("streets")).pinned).toBe(true);
  expect(await tagInfo("cloudy")).toBeNull();
  expect(await tagsOf(photos[1])).toEqual(["sunny"]);
  await allAssets();
  await card(photos[1]).click();
  await expect(ctx.window.getByTestId("inspector-tags").locator("[data-tag-group='weather'] [data-tag='sunny']")).toBeVisible();
});
