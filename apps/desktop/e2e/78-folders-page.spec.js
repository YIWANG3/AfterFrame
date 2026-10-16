// The folder page (docs/folders-page-plan.md): opened from the sidebar's
// folder header, it lists every folder with its cover mosaic, count and
// capture span, searches and sorts them, filters by status, switches to a
// table, and deletes a multi-selection after one confirm. The sidebar and
// Discover read the same rows, so they follow.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

let ctx;
const w = () => ctx.window;
const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const cards = () => w().locator("[data-folder-id]");
const names = () => cards().evaluateAll((els) => els.map((el) => el.querySelector(".truncate")?.textContent?.trim()));
const sidebarRows = () => w().getByTestId("sidebar-folder-scroll").locator("[data-collection-id]");

async function openFoldersPage() {
  await w().getByTestId("sidebar-manage-folders").click();
  await expect(w().getByRole("heading", { name: "Folders", exact: true })).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "folders-page" });
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
  // Three folders through the agent surface: two with photos (Kyoto's added
  // last), one that never got any. The fixture's dated photos come first
  // under captured-desc, so the folders get a capture span.
  const { assets } = await callTool("search_assets", { limit: 3, sort: "captured-desc" });
  const tokyo = await callTool("manage_collections", { action: "create", name: "Trip Tokyo" });
  await callTool("manage_collections", { action: "add_items", collection_id: tokyo.collection_id, asset_ids: [assets[0].asset_id, assets[1].asset_id] });
  const kyoto = await callTool("manage_collections", { action: "create", name: "Trip Kyoto" });
  await callTool("manage_collections", { action: "add_items", collection_id: kyoto.collection_id, asset_ids: [assets[2].asset_id] });
  await callTool("manage_collections", { action: "create", name: "Scratch" });
  // Right after launch the sidecar is still busy with its startup work
  // (self-heal refresh, facet counts), and the sidebar's reload queues
  // behind it: seconds on a cold runner.
  await expect.poll(() => w().evaluate(() => window.mediaWorkspace.listCollections().then((rows) => rows.map((r) => r.name))), { timeout: 20_000 })
    .toEqual(["Scratch", "Trip Kyoto", "Trip Tokyo"]);
  await expect(sidebarRows()).toHaveCount(3, { timeout: 20_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("the rows carry the page's columns", async () => {
  const { collections } = await callTool("manage_collections", { action: "list" });
  const tokyo = collections.find((c) => c.name === "Trip Tokyo");
  expect(tokyo.item_count).toBe(2);
  expect(tokyo.cover_preview_paths).toHaveLength(2);
  expect(tokyo.last_added_at).toBeTruthy();
  expect(typeof tokyo.captured_from).toBe("string");
  expect(tokyo.captured_from <= tokyo.captured_to).toBe(true);
  const scratch = collections.find((c) => c.name === "Scratch");
  expect(scratch).toMatchObject({ item_count: 0, last_added_at: null, captured_from: null, captured_to: null, cover_preview_paths: [] });
});

test("the page lists every folder, newest addition first, with cover and count", async () => {
  await openFoldersPage();
  await expect(w().getByTestId("folders-count")).toHaveText("· 3");
  await expect(cards()).toHaveCount(3);
  // Kyoto got its photo last; Scratch never got one and sinks to the end.
  await expect.poll(names).toEqual(["Trip Kyoto", "Trip Tokyo", "Scratch"]);
  const tokyo = cards().filter({ hasText: "Trip Tokyo" });
  await expect(tokyo).toContainText("2 items");
  await expect(tokyo.locator("[data-cover-count]")).toHaveAttribute("data-cover-count", "2");
  await expect(tokyo.locator("img")).toHaveCount(2);
  await expect(cards().filter({ hasText: "Scratch" })).toContainText("Empty");
  // Nothing is selected on the way in, so no action bar.
  await expect(w().getByTestId("folders-selection-bar")).toHaveCount(0);
});

test("search and sort narrow and reorder the wall", async () => {
  const search = w().getByPlaceholder("Search folders");
  await search.fill("trip");
  await expect.poll(names).toEqual(["Trip Kyoto", "Trip Tokyo"]);
  await search.fill("zzz");
  await expect(w().getByText("No folders match “zzz”")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(cards()).toHaveCount(3);

  await w().getByTestId("folders-sort").click();
  await w().getByRole("button", { name: "Name", exact: true }).click();
  await expect.poll(names).toEqual(["Scratch", "Trip Kyoto", "Trip Tokyo"]);
  await w().getByTestId("folders-sort").click();
  await w().getByRole("button", { name: "Most photos", exact: true }).click();
  await expect.poll(names).toEqual(["Trip Tokyo", "Trip Kyoto", "Scratch"]);
});

test("the status facet keeps the empty folders, Clear brings the rest back", async () => {
  await w().getByTestId("folders-filters-toggle").click();
  const bar = w().getByTestId("folders-filter-bar");
  await expect(bar).toBeVisible();
  // The gallery's own facets, reused: photo count and capture dates.
  await expect(bar.getByRole("button", { name: /^Photos/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Date/ })).toBeVisible();
  await bar.getByRole("button", { name: /^Status/ }).click();
  await w().locator("[data-popover-panel] [data-facet-option='empty']").click();
  await expect.poll(names).toEqual(["Scratch"]);
  await expect(bar.getByRole("button", { name: /^Empty/ })).toBeVisible();
  await bar.getByRole("button", { name: "Clear 1" }).click();
  await expect(cards()).toHaveCount(3);
  await w().getByTestId("folders-filters-toggle").click();
  await expect(bar).toHaveCount(0);
});

test("the list view is a table with the same rows, sortable by its headers", async () => {
  await w().getByTestId("folders-view-list").click();
  const table = w().getByTestId("folders-list");
  await expect(table).toBeVisible();
  await expect(cards()).toHaveCount(3);
  await expect.poll(names).toEqual(["Trip Tokyo", "Trip Kyoto", "Scratch"]);
  const tokyo = table.locator("tr[data-folder-id]").filter({ hasText: "Trip Tokyo" });
  await expect(tokyo.locator("td").nth(3)).toHaveText("2");
  await expect(tokyo.locator("td").nth(5)).toContainText(/now|ago|minute/);
  await table.getByRole("button", { name: "Name" }).click();
  await expect.poll(names).toEqual(["Scratch", "Trip Kyoto", "Trip Tokyo"]);
  await expect(w().getByTestId("folders-sort")).toHaveText("Name");
});

test("Edit turns the page into a picker; a shift-click range deletes after one confirm; the sidebar follows", async () => {
  const row = (name) => cards().filter({ hasText: name });
  // Browsing: no checkboxes, and nothing is selectable.
  await expect(cards().first().getByRole("button", { pressed: false })).toHaveCount(0);
  await w().getByTestId("folders-edit").click();
  await expect(w().getByTestId("folders-edit")).toHaveText("Done");
  await expect(cards().first().getByRole("button", { pressed: false })).toHaveCount(1);
  await row("Scratch").click();
  await row("Trip Kyoto").click({ modifiers: ["Shift"] });
  const bar = w().getByTestId("folders-selection-bar");
  await expect(bar).toContainText("2 folders selected · 1 photos");
  await w().getByTestId("folders-delete-selected").click();
  await expect(w().getByText("Delete 2 folders?")).toBeVisible();
  await w().getByRole("button", { name: "Delete 2 folders" }).click();
  await expect(cards()).toHaveCount(1);
  await expect.poll(names).toEqual(["Trip Tokyo"]);
  await expect(bar).toHaveCount(0);
  await expect(sidebarRows()).toHaveCount(1);
  const { collections } = await callTool("manage_collections", { action: "list" });
  expect(collections.map((c) => c.name)).toEqual(["Trip Tokyo"]);
});

test("Escape clears the selection, then leaves edit mode; a plain click opens the folder in the gallery", async () => {
  // Still editing after the delete: the remaining folder can be picked.
  await cards().first().click();
  await expect(w().getByTestId("folders-selection-bar")).toBeVisible();
  await w().keyboard.press("Escape");
  await expect(w().getByTestId("folders-selection-bar")).toHaveCount(0);
  await expect(w().getByTestId("folders-edit")).toHaveText("Done");
  await w().keyboard.press("Escape");
  await expect(w().getByTestId("folders-edit")).toHaveText("Edit");
  // Browsing again: a click is a jump into the folder.
  await cards().first().click();
  await expect(w().getByTestId("gallery-title")).toHaveText("Trip Tokyo");
  await expect(galleryCards(w())).toHaveCount(2, { timeout: 10_000 });
  await expect(sidebarRows().first()).toHaveClass(/bg-selected/);
});

test("Discover's Albums row links to the page, and it survives a reload", async () => {
  await w().getByRole("navigation").first().getByRole("button", { name: "Discover" }).click();
  await w().getByRole("button", { name: "All folders ›" }).click();
  await expect(w().getByRole("heading", { name: "Folders", exact: true })).toBeVisible();
  await expect(cards()).toHaveCount(1);
  await w().reload();
  await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
  await openFoldersPage();
  await expect.poll(names).toEqual(["Trip Tokyo"]);
  // The page's own view preference came back with it.
  await expect(w().getByTestId("folders-list")).toBeVisible();
});
