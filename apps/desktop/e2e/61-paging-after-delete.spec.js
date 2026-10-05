const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");
const { cloneAssets } = require("./helpers/clone-assets");

// The gallery pages by server offset. Deleting photos, or taking them out of
// the folder on screen, drops them from the loaded list and from the server's
// list alike. The offset has to fall with them: left where it was, the next
// page started that many rows late and those photos never showed.

const BULK = 600; // several pages of 180, so a page is still to come once the first loads settle
const SORT = "imported-desc"; // the gallery's default order

let ctx;
const scroller = () => ctx.window.locator("[data-testid='gallery-scroll']");
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const selected = () => ctx.window.locator("[data-gallery-item='true'][data-selected='true']");
const scrollHeight = () => scroller().evaluate((el) => el.scrollHeight);

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

// The opening page and any preload it triggers.
async function settle() {
  let last = -1;
  await expect.poll(async () => {
    const now = await scrollHeight();
    const settled = now === last;
    last = now;
    return settled;
  }, { timeout: 15_000, intervals: [1000] }).toBe(true);
}

// Every card the grid holds. It only renders what is in view, so walk it.
function walkGrid() {
  return scroller().evaluate(async (el) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const seen = new Set();
    for (let top = 0; top <= el.scrollHeight; top += Math.max(100, el.clientHeight / 2)) {
      el.scrollTop = top;
      await frame();
      for (const card of el.querySelectorAll("[data-gallery-item='true']")) seen.add(card.dataset.assetId);
    }
    return [...seen];
  });
}

// Select the first three cards, take them out with `remove`, load the next
// page, then check the grid against the server's own list: everything up to
// the last card shown is there, and none of the removed ones.
async function removeThreeThenLoadMore(remove, listServerIds) {
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await settle();
  await cards().nth(0).click();
  await cards().nth(2).click({ modifiers: ["Shift"] });
  await expect(selected()).toHaveCount(3);
  const removed = await selected().evaluateAll((els) => els.map((el) => el.dataset.assetId));

  await remove();
  for (const id of removed) {
    await expect(ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`)).toHaveCount(0, { timeout: 10_000 });
  }
  await settle();

  const before = await scrollHeight();
  await scroller().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(scrollHeight, { timeout: 15_000 }).toBeGreaterThan(before);
  await settle();

  const server = await listServerIds();
  const shown = new Set(await walkGrid());
  expect(server.slice(0, shown.size).filter((id) => !shown.has(id))).toEqual([]);
  expect(removed.filter((id) => shown.has(id))).toEqual([]);
}

// A launch per test. Walking the grid shows the seeded photos at the bottom,
// whose stale metadata starts a self-heal; its refresh would land in the next
// test's view and preload that view to the end.
test.beforeEach(async () => {
  ctx = await launchApp({
    testName: "paging-after-delete",
    prepareCatalog: (dir) => cloneAssets(dir, Array.from({ length: BULK }, (_, i) => `bulk-${String(i + 1).padStart(4, "0")}`)),
  });
});

test.afterEach(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  ctx = null;
});

test("deleting loaded photos doesn't skip the ones the next page starts with", async () => {
  await removeThreeThenLoadMore(
    async () => {
      await ctx.window.keyboard.press("Delete");
      await ctx.window.getByRole("button", { name: "Remove", exact: true }).click();
    },
    () => ctx.window.evaluate(async (sort) => {
      const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 5000, sort });
      return rows.map((row) => row.asset_id);
    }, SORT),
  );
});

test("removing loaded photos from a folder doesn't skip the next page's first ones", async () => {
  const assetIds = await ctx.window.evaluate(async () => {
    const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 5000 });
    return rows.map((row) => row.asset_id);
  });
  const created = await callTool("manage_collections", { action: "create", name: "Paging" });
  const collectionId = created.collection_id || created.id;
  await callTool("manage_collections", { action: "add_items", collection_id: collectionId, asset_ids: assetIds });

  await ctx.window.getByTestId("sidebar-folder-scroll").getByText("Paging", { exact: true }).click();
  await removeThreeThenLoadMore(
    async () => {
      await cards().nth(0).click({ button: "right" });
      await ctx.window.getByText("Remove from Folder", { exact: true }).click();
    },
    () => ctx.window.evaluate(async ({ id, sort }) => {
      const rows = await window.mediaWorkspace.browseCollection(id, { limit: 5000, sort });
      return rows.map((row) => row.asset_id);
    }, { id: collectionId, sort: SORT }),
  );
});
