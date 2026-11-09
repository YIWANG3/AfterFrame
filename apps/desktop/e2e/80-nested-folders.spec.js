// Nested folders: a folder inside a folder, any depth. The sidebar shows them
// as a tree (open / close, a subfolder made from a row's hover button, a
// folder dragged onto another to nest it, dragged to the top-level zone to
// bring it back out); a parent shows its subfolders' photos until the
// toolbar switch says this folder only (remembered); the right-click submenu,
// the folder page and the MCP tools reach every level; deleting a folder
// takes the folders under it, and the tree survives a restart.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, callTool: mcpTool, galleryCards } = require("./helpers/app");

let ctx;
const w = () => ctx.window;
const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const scroll = () => w().getByTestId("sidebar-folder-scroll");
const row = (name) => scroll().locator("[data-collection-id]").filter({ has: w().locator("span.truncate", { hasText: new RegExp(`^${name}$`) }) });
const rowNames = () => scroll().locator("[data-collection-id]").evaluateAll((rows) => rows.map((r) => `${r.dataset.folderDepth}:${r.querySelector("span.truncate")?.textContent}`));
const cards = () => galleryCards(w());
const folders = async () => {
  const { collections } = await callTool("manage_collections", { action: "list" });
  return Object.fromEntries(collections.filter((c) => c.kind === "manual").map((c) => [c.name, c]));
};

let assets;

async function newTopLevelFolder(name) {
  await w().getByTitle("New folder", { exact: true }).click();
  const field = scroll().locator("input");
  await field.fill(name);
  await field.press("Enter");
  await expect(row(name)).toBeVisible({ timeout: 15_000 });
}

async function newSubfolder(parentName, name) {
  await row(parentName).hover();
  await row(parentName).getByLabel("New subfolder", { exact: true }).click();
  const field = w().getByTestId("sidebar-new-subfolder").locator("input");
  await field.fill(name);
  await field.press("Enter");
  await expect(row(name)).toBeVisible({ timeout: 15_000 });
}

// Electron hands drags to the OS, so the DOM events are dispatched directly
// (helpers/folder-order.js does the same). `at` is the fraction of the target
// row's height: 0.5 is its middle (into), near 0 or 1 its edges (before / after).
async function dragFolderOnto(sourceName, target, { at = 0.5 } = {}) {
  const transfer = await w().evaluateHandle(() => new DataTransfer());
  await row(sourceName).dispatchEvent("dragstart", { dataTransfer: transfer });
  const box = await target.boundingBox();
  const point = { clientX: box.x + 24, clientY: box.y + box.height * at };
  await target.dispatchEvent("dragover", { dataTransfer: transfer, ...point });
  return {
    transfer,
    drop: async () => {
      await target.dispatchEvent("drop", { dataTransfer: transfer, ...point });
      await row(sourceName).dispatchEvent("dragend", { dataTransfer: transfer });
      await transfer.dispose();
    },
    cancel: async () => {
      await row(sourceName).dispatchEvent("dragend", { dataTransfer: transfer });
      await transfer.dispose();
    },
  };
}

async function dropPhotoOn(assetId, target) {
  const transfer = await w().evaluateHandle((id) => {
    const data = new DataTransfer();
    data.setData("application/x-media-workspace-asset", JSON.stringify({ assetIds: [id] }));
    return data;
  }, assetId);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "nested-folders" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  ({ assets } = await callTool("search_assets", { limit: 3, sort: "captured-desc" }));
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a subfolder is made from a row; the tree opens and closes", async () => {
  await newTopLevelFolder("Trips");
  await newSubfolder("Trips", "Japan");
  await newSubfolder("Japan", "Kyoto");
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Japan", "2:Kyoto"]);
  await expect(row("Trips")).toHaveAttribute("data-folder-expanded", "true");
  // Close Trips: everything under it goes; open it again.
  await row("Trips").locator("[data-folder-toggle]").click();
  await expect.poll(rowNames).toEqual(["0:Trips"]);
  await row("Trips").locator("[data-folder-toggle]").click();
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Japan", "2:Kyoto"]);
  const tree = await folders();
  expect(tree.Kyoto.path).toBe("Trips / Japan / Kyoto");
  expect(tree.Kyoto.depth).toBe(2);
  expect(tree.Japan.parent_collection_id).toBe(tree.Trips.collection_id);
});

test("a parent shows its subfolders' photos until the switch says this folder only", async () => {
  await dropPhotoOn(assets[0].asset_id, row("Kyoto"));
  await expect(row("Kyoto").locator("span.tabular-nums")).toHaveText("1", { timeout: 10_000 });
  const tree = await folders();
  expect(tree.Trips.item_count).toBe(0);
  expect(tree.Trips.subtree_count).toBe(1);
  // A closed folder counts everything under it.
  await row("Trips").locator("[data-folder-toggle]").click();
  await expect(row("Trips").locator("span.tabular-nums")).toHaveText("1");
  await row("Trips").locator("[data-folder-toggle]").click();
  await expect(row("Trips").locator("span.tabular-nums")).toHaveText("0");

  await row("Trips").click();
  await expect(w().getByTestId("gallery-title")).toHaveText("Trips");
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  const toggle = w().getByTestId("toolbar-subfolders");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(cards()).toHaveCount(0, { timeout: 10_000 });
  // The choice follows into the next folder; the title says where it is.
  await row("Japan").click();
  await expect(w().getByTestId("gallery-title")).toHaveText("Trips / Japan");
  await expect(w().getByTestId("toolbar-subfolders")).toHaveAttribute("aria-pressed", "false");
  await expect(cards()).toHaveCount(0);
  await w().getByTestId("toolbar-subfolders").click();
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  // A leaf has nothing to switch.
  await row("Kyoto").click();
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  await expect(w().getByTestId("toolbar-subfolders")).toHaveCount(0);
});

test("dragging a folder into another nests it; the top-level zone brings it back; a cycle is refused", async () => {
  await newTopLevelFolder("Europe");
  await expect.poll(rowNames).toEqual(["0:Europe", "0:Trips", "1:Japan", "2:Kyoto"]);
  const into = await dragFolderOnto("Europe", row("Trips"));
  await expect(row("Trips")).toHaveAttribute("data-folder-insertion", "into");
  await into.drop();
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Europe", "1:Japan", "2:Kyoto"]);
  let tree = await folders();
  expect(tree.Europe.parent_collection_id).toBe(tree.Trips.collection_id);

  // Into itself or one of its own folders: no marker, nothing moves.
  const refused = await dragFolderOnto("Trips", row("Kyoto"));
  await expect(row("Kyoto")).not.toHaveAttribute("data-folder-insertion", /.*/);
  await refused.drop();
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Europe", "1:Japan", "2:Kyoto"]);

  // Back out: the zone under the rows shows while a folder drags.
  const transfer = await w().evaluateHandle(() => new DataTransfer());
  await row("Europe").dispatchEvent("dragstart", { dataTransfer: transfer });
  const zone = w().locator("[data-folder-root-zone]");
  await expect(zone).toBeVisible();
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(zone).toHaveAttribute("data-active", "true");
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  await row("Europe").dispatchEvent("dragend", { dataTransfer: transfer });
  await transfer.dispose();
  await expect.poll(rowNames).toEqual(["0:Europe", "0:Trips", "1:Japan", "2:Kyoto"]);
  tree = await folders();
  expect(tree.Europe.parent_collection_id).toBeNull();
  // A same-level drop at the edge of a row still reorders (custom order).
  const after = await dragFolderOnto("Europe", row("Trips"), { at: 0.95 });
  await expect(row("Trips")).toHaveAttribute("data-folder-insertion", "after");
  await after.drop();
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Japan", "2:Kyoto", "0:Europe"]);
});

test("the right-click submenu and the folder page reach nested folders", async () => {
  await w().getByRole("button", { name: /All Assets/i }).first().click();
  await expect(cards().nth(1)).toBeVisible({ timeout: 10_000 });
  const second = w().locator(`[data-asset-id="${assets[1].asset_id}"]`);
  await second.click();
  await second.click({ button: "right" });
  await w().getByText("Add to Folder", { exact: true }).hover();
  const kyoto = w().getByRole("button", { name: "Kyoto", exact: true });
  await expect(kyoto).toHaveAttribute("data-folder-depth", "2");
  await kyoto.click();
  await expect(row("Kyoto").locator("span.tabular-nums")).toHaveText("2", { timeout: 10_000 });

  await w().getByTestId("sidebar-manage-folders").click();
  await expect(w().getByRole("heading", { name: "Folders", exact: true })).toBeVisible({ timeout: 10_000 });
  const card = (name) => w().locator("[data-folder-id]").filter({ has: w().locator("[data-folder-name]", { hasText: new RegExp(`^${name}$`) }) });
  await expect(card("Kyoto").locator("[data-folder-location]")).toHaveText("Trips / Japan");
  await expect(card("Trips").locator("[data-folder-location]")).toHaveCount(0);
  // Move to… the top level, then back under Japan.
  await card("Kyoto").click({ button: "right" });
  await w().getByRole("button", { name: "Move to…" }).click();
  await w().locator("[data-testid='folders-move-menu'] [data-move-target='root']").click();
  await expect(card("Kyoto").locator("[data-folder-location]")).toHaveCount(0, { timeout: 10_000 });
  const tree = await folders();
  expect(tree.Kyoto.parent_collection_id).toBeNull();
  await card("Kyoto").click({ button: "right" });
  await w().getByRole("button", { name: "Move to…" }).click();
  await w().locator(`[data-testid='folders-move-menu'] [data-move-target='${tree.Japan.collection_id}']`).click();
  await expect(card("Kyoto").locator("[data-folder-location]")).toHaveText("Trips / Japan", { timeout: 10_000 });
  // The list view says where each folder sits.
  await w().getByTestId("folders-view-list").click();
  const japanRow = w().getByTestId("folders-list").locator("tr[data-folder-id]").filter({ has: w().locator("[data-folder-name]", { hasText: /^Japan$/ }) });
  await expect(japanRow.locator("td").nth(3)).toHaveText("Trips");
  await w().getByTestId("folders-view-grid").click();
});

test("the MCP tools make, move and browse nested folders", async () => {
  const tree = await folders();
  const asia = await callTool("manage_collections", { action: "create", name: "Asia", parent_id: tree.Trips.collection_id });
  expect(asia.parent_collection_id).toBe(tree.Trips.collection_id);
  expect((await folders()).Asia.path).toBe("Trips / Asia");
  const moved = await callTool("manage_collections", { action: "move", collection_id: asia.collection_id, parent_id: tree.Japan.collection_id });
  expect(moved.moved).toBe(true);
  expect((await folders()).Asia.path).toBe("Trips / Japan / Asia");
  await expect(callTool("manage_collections", { action: "move", collection_id: tree.Trips.collection_id, parent_id: tree.Kyoto.collection_id })).rejects.toThrow(/into itself/);
  await callTool("manage_collections", { action: "move", collection_id: asia.collection_id });
  expect((await folders()).Asia.parent_collection_id).toBeNull();
  await callTool("manage_collections", { action: "delete", collection_id: asia.collection_id });

  const direct = await callTool("manage_collections", { action: "browse", collection_id: tree.Trips.collection_id });
  expect(direct.count).toBe(0);
  const whole = await callTool("manage_collections", { action: "browse", collection_id: tree.Trips.collection_id, include_descendants: true });
  expect(whole.assets.map((a) => a.asset_id).sort()).toEqual([assets[0].asset_id, assets[1].asset_id].sort());
  const found = await callTool("search_assets", { collection_id: tree.Trips.collection_id, include_descendants: true });
  expect(found.count).toBe(2);
  expect((await callTool("search_assets", { collection_id: tree.Trips.collection_id })).count).toBe(0);
  const list = (await callTool("manage_collections", { action: "list" })).collections.find((c) => c.name === "Trips");
  expect(list).toMatchObject({ item_count: 0, subtree_count: 2, depth: 0, path: "Trips" });
});

test("the tree, what is open and the switch survive a restart", async () => {
  // Switch Trips to this folder only, so the remembered choice can be seen.
  await w().getByRole("button", { name: /All Assets/i }).first().click();
  await row("Trips").click();
  await expect(cards()).toHaveCount(2, { timeout: 10_000 });
  await w().getByTestId("toolbar-subfolders").click();
  await expect(cards()).toHaveCount(0, { timeout: 10_000 });
  await row("Japan").locator("[data-folder-toggle]").click();
  await expect.poll(rowNames).toEqual(["0:Trips", "1:Japan", "0:Europe"]);

  await collectCoverage(ctx.app);
  await ctx.app.close();
  ctx = await launchApp({ testName: "nested-folders", reuseUserDataDir: ctx.userDataDir, keepCatalog: true });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(rowNames, { timeout: 20_000 }).toEqual(["0:Trips", "1:Japan", "0:Europe"]);
  const tree = await folders();
  expect(tree.Kyoto.path).toBe("Trips / Japan / Kyoto");
  await row("Trips").click();
  await expect(w().getByTestId("toolbar-subfolders")).toHaveAttribute("aria-pressed", "false");
  await expect(cards()).toHaveCount(0);
  await w().getByTestId("toolbar-subfolders").click();
  await expect(cards()).toHaveCount(2, { timeout: 10_000 });
});

test("deleting a folder takes the folders under it; the photos stay", async () => {
  const before = (await callTool("get_catalog_info", {})).asset_count ?? null;
  // The sidebar asks first when there are folders inside.
  await row("Japan").hover();
  await row("Japan").getByTitle("Delete", { exact: true }).click();
  await expect(w().getByText("Delete “Japan”?")).toBeVisible();
  await expect(w().getByText(/Its 1 subfolder goes with it/)).toBeVisible();
  await w().getByRole("button", { name: "Delete folder", exact: true }).click();
  await expect.poll(rowNames, { timeout: 10_000 }).toEqual(["0:Trips", "0:Europe"]);
  const tree = await folders();
  expect(Object.keys(tree).sort()).toEqual(["Europe", "Trips"]);
  // Both photos are still in the library.
  const all = await callTool("search_assets", { limit: 1000 });
  expect(all.assets.map((a) => a.asset_id)).toEqual(expect.arrayContaining([assets[0].asset_id, assets[1].asset_id]));
  if (before != null) expect((await callTool("get_catalog_info", {})).asset_count).toBe(before);

  // The folder page's confirm says so too when the selection holds a parent.
  await newSubfolder("Trips", "Japan");
  await w().getByTestId("sidebar-manage-folders").click();
  const card = (name) => w().locator("[data-folder-id]").filter({ has: w().locator("[data-folder-name]", { hasText: new RegExp(`^${name}$`) }) });
  await card("Trips").click();
  await w().getByTestId("folders-delete-selected").click();
  await expect(w().getByText("Their subfolders go with them. The photos stay in the library.")).toBeVisible();
  await w().getByRole("button", { name: "Delete folder", exact: true }).click();
  await expect.poll(async () => Object.keys(await folders()).sort(), { timeout: 10_000 }).toEqual(["Europe"]);
});
