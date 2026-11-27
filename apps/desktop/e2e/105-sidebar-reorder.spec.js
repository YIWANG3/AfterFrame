// The sidebar's entries and its three sections are the user's to order: an
// entry is dragged by itself among the entries, a section by its heading
// among the sections. All Assets stays first and doesn't move. The order is
// remembered, and Settings › General › Sidebar lists the switches in it.
// One app launch, on the seeded catalog; the tests build on each other.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

test.describe("ordering the sidebar", () => {
  test.describe.configure({ mode: "serial" });
  let ctx;
  const w = () => ctx.window;
  const nav = () => w().locator("aside nav").first();
  const entry = (id) => nav().locator(`[data-reorder-group='entries'][data-reorder-item='${id}']`);
  const section = (id) => nav().locator(`[data-reorder-group='sections'][data-reorder-item='${id}']`);
  const heading = (toggle) => w().locator(`[data-sidebar-section-toggle='${toggle}']`).locator("..");
  const order = (group) => nav().evaluate((el, name) => Array.from(el.querySelectorAll(`[data-reorder-group='${name}']`)).map((item) => item.dataset.reorderItem), group);

  // Electron hands drags to the OS, so the DOM events are dispatched
  // directly, as in 80-nested-folders. `at` is the fraction of the target's
  // height the pointer is at: its top half lands before it, its bottom half after.
  async function drag(source, target, { at = 0.25, drop = true } = {}) {
    const transfer = await w().evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    const box = await target.boundingBox();
    const point = { clientX: box.x + 24, clientY: box.y + box.height * at };
    await target.dispatchEvent("dragenter", { dataTransfer: transfer, ...point });
    await target.dispatchEvent("dragover", { dataTransfer: transfer, ...point });
    if (drop) await target.dispatchEvent("drop", { dataTransfer: transfer, ...point });
    await source.dispatchEvent("dragend", { dataTransfer: transfer });
    await transfer.dispose();
  }

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "sidebar-reorder" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect(w().locator("[data-disk-folders] [data-disk-folder]").first()).toBeVisible({ timeout: 15_000 });
    await w().evaluate(async () => {
      await window.mediaWorkspace.createCollection("Kept as it is", "manual");
      await window.mediaWorkspace.createCollection("Rated", "smart", { filters: { rating_min: 1 } });
    });
    await w().reload();
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect(w().locator("[data-collection-id]")).toHaveCount(1);
    await expect(w().locator("[data-smart-collection]")).toHaveCount(1);
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("an entry dragged above another lands there; All Assets stays first and can't be dragged", async () => {
    const before = await order("entries");
    expect(before.slice(0, 2)).toEqual(["discover", "recent"]);
    expect(before.at(-1)).toBe("stats");

    // While it is over Recently Added's top half, a line shows where it lands,
    // and the entry being dragged dims.
    const transfer = await w().evaluateHandle(() => new DataTransfer());
    await entry("stats").dispatchEvent("dragstart", { dataTransfer: transfer });
    const box = await entry("recent").boundingBox();
    await entry("recent").dispatchEvent("dragover", { dataTransfer: transfer, clientX: box.x + 24, clientY: box.y + 2 });
    await expect(entry("recent")).toHaveAttribute("data-reorder-drop", "before");
    await expect(entry("stats")).toHaveAttribute("data-reorder-dragging", "true");
    await entry("recent").dispatchEvent("drop", { dataTransfer: transfer, clientX: box.x + 24, clientY: box.y + 2 });
    await entry("stats").dispatchEvent("dragend", { dataTransfer: transfer });
    await transfer.dispose();

    await expect.poll(() => order("entries")).toEqual(["discover", "stats", ...before.slice(1, -1)]);
    await expect(nav().locator("[data-reorder-drop], [data-reorder-dragging]")).toHaveCount(0);
    // The moved entry still opens its page.
    await entry("stats").click();
    await expect(entry("stats")).toHaveClass(/bg-selected/);

    // All Assets is the first button, and isn't an entry that moves.
    const all = nav().getByRole("button", { name: /^All Assets/ });
    await expect(all).not.toHaveAttribute("draggable", "true");
    await expect(all).not.toHaveAttribute("data-reorder-item", /.*/);
    expect(await nav().locator("button").first().textContent()).toMatch(/^All Assets/);
  });

  test("a section dragged by its heading lands among the sections, and its rows go with it", async () => {
    // Folders, by its heading, onto the top half of Smart Collections.
    await drag(heading("diskFolders"), section("smartCollections"));
    await expect.poll(() => order("sections")).toEqual(["diskFolders", "smartCollections", "collections"]);
    await expect(section("diskFolders").locator("[data-disk-folder]").first()).toBeVisible();

    // Smart Collections onto the bottom half of Collections, over one of its
    // rows: the section moves, and the row takes nothing from the drag.
    await drag(heading("smart"), w().locator("[data-collection-id]").first(), { at: 0.75 });
    await expect.poll(() => order("sections")).toEqual(["diskFolders", "collections", "smartCollections"]);
    const collections = await w().evaluate(() => window.mediaWorkspace.listCollections());
    const kept = collections.find((item) => item.name === "Kept as it is");
    expect(kept).toEqual(expect.objectContaining({ item_count: 0, parent_collection_id: null }));
    expect(collections.filter((item) => item.kind !== "smart")).toHaveLength(1);
    await expect(w().locator("[data-smart-collection]")).toHaveCount(1);
  });

  test("an entry never lands among the sections, nor a section among the entries", async () => {
    const entries = await order("entries");
    const sections = await order("sections");
    await drag(entry("tags"), section("collections"));
    await drag(heading("folders"), entry("recent"));
    expect(await order("entries")).toEqual(entries);
    expect(await order("sections")).toEqual(sections);
    // A drag let go nowhere changes nothing either.
    await drag(entry("people"), entry("recent"), { drop: false });
    expect(await order("entries")).toEqual(entries);
  });

  test("the order is remembered, and Settings lists the switches in it", async () => {
    const entries = await order("entries");
    const sections = await order("sections");
    await w().reload();
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => order("entries")).toEqual(entries);
    await expect.poll(() => order("sections")).toEqual(sections);

    await entry("tags").click({ button: "right" });
    await w().getByTestId("sidebar-entry-menu").locator("[data-menu-item='customize']").click();
    const settings = w().getByTestId("sidebar-settings");
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const listed = await settings.locator("[data-sidebar-entry]").evaluateAll((items) => items.map((item) => item.dataset.sidebarEntry));
    // Settings also lists what this library has none of yet (Look-alikes).
    const shown = [...entries, ...sections];
    expect(listed.filter((id) => shown.includes(id))).toEqual(shown);
    // A hidden entry keeps its place: shown again, it is back where it was.
    await settings.locator("[data-sidebar-entry='stats'] [role='switch']").click();
    await expect(entry("stats")).toHaveCount(0);
    await settings.locator("[data-sidebar-entry='stats'] [role='switch']").click();
    await w().keyboard.press("Escape");
    await expect.poll(() => order("entries")).toEqual(entries);
  });
});
