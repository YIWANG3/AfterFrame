// Collections and folders (docs/collections-and-folders-design.md). The
// sidebar has one Collections heading (Manual and Smart groups) and a Folders
// section below: the folders on disk the library's photos are in, a read-only
// mirror. A folder opens as a place, with or without the folders under it;
// the Inspector's Folder row goes to a photo's folder. A folder moved in
// Finder shows as not found until it is located. Save as Collection is a
// one-time copy, grouped by subfolder if asked. Auto-sync is the folder being
// watched: a shoot moved into it comes in by itself. Remove from Library
// takes the folder's photos out, after a choice.
//
// Only fresh temp files are moved; the committed fixtures are never touched.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, importThroughToolbar, galleryCards } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

test.describe("folders on disk", () => {
  test.describe.configure({ mode: "serial" });
  let ctx, root, year;

  const w = () => ctx.window;
  // A backslash starts a CSS escape: a Windows path has its own doubled, as
  // byImagePath() does.
  const css = (value) => value.replace(/[\\"]/g, "\\$&");
  const folderRow = (dir) => w().locator(`[data-disk-folder="${css(dir)}"]`);
  const menuItem = (key) => w().getByTestId("sidebar-disk-folder-menu").locator(`[data-menu-item='${key}']`);
  const rows = async () => (await w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })))
    .filter((row) => String(row.image_path || "").startsWith(root));
  const importDone = () => expect.poll(
    () => w().evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)),
    { timeout: 60_000, intervals: [250] },
  ).toBe(false);
  // The dev build's Design System button floats over the sidebar's bottom
  // left, where a folder's chevron can sit: the toggle is clicked as an event.
  const expand = (dir) => w().locator(`[data-disk-folder-toggle="${css(dir)}"]`).dispatchEvent("click");
  const openMenu = async (dir) => {
    await folderRow(dir).scrollIntoViewIfNeeded();
    await folderRow(dir).click({ button: "right" });
    await expect(w().getByTestId("sidebar-disk-folder-menu")).toBeVisible();
  };

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-folders-")));
    year = path.join(root, "Photos", "2026");
    fs.mkdirSync(path.join(year, "Tokyo"), { recursive: true });
    fs.mkdirSync(path.join(year, "Kyoto"), { recursive: true });
    await writeUniqueJpeg(path.join(year, "Tokyo", "Folders_a.jpg"));
    await writeUniqueJpeg(path.join(year, "Tokyo", "Folders_b.jpg"));
    await writeUniqueJpeg(path.join(year, "Kyoto", "Folders_c.jpg"));
    await writeUniqueJpeg(path.join(year, "Folders_d.jpg"));
    ctx = await launchApp({ testName: "disk-folders" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await importThroughToolbar(ctx.app, w(), [path.join(root, "Photos")]);
    await expect.poll(async () => (await rows()).length, { timeout: 90_000 }).toBe(4);
    await importDone();
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("the sidebar has Collections (Manual, Smart) and the folders on disk, folded down to the photos", async () => {
    await expect(w().locator("[data-sidebar-collections-heading]")).toHaveText("Collections");
    await expect(w().locator("[data-sidebar-section-toggle='folders']")).toContainText("Manual");
    await expect(w().locator("[data-sidebar-section-toggle='diskFolders']")).toContainText("Folders");
    // Photos holds nothing itself and one folder: the tree starts at 2026.
    await expect(folderRow(year)).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(path.join(root, "Photos"))).toHaveCount(0);
    await expect(folderRow(year).locator("span.tabular-nums")).toHaveText("4");
    await expect(folderRow(path.join(year, "Tokyo"))).toHaveCount(0);
    await expand(year);
    await expect(folderRow(path.join(year, "Tokyo")).locator("span.tabular-nums")).toHaveText("2");
    await expect(folderRow(path.join(year, "Kyoto"))).toBeVisible();
  });

  test("a folder opens as a place, with or without the folders under it", async () => {
    await folderRow(year).click();
    await expect(w().locator(".app-toolbar")).toContainText("2026");
    await expect(galleryCards(w())).toHaveCount(4, { timeout: 15_000 });
    const toggle = w().getByTestId("toolbar-subfolders");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(galleryCards(w())).toHaveCount(1, { timeout: 15_000 });
    await toggle.click();
    await expect(galleryCards(w())).toHaveCount(4, { timeout: 15_000 });

    await folderRow(path.join(year, "Tokyo")).click();
    await expect(galleryCards(w())).toHaveCount(2, { timeout: 15_000 });
    // Nothing to save as a smart collection from a folder on disk.
    await expect(w().getByRole("button", { name: "Save as smart collection" })).toHaveCount(0);
  });

  test("the Inspector's Folder row opens the photo's folder", async () => {
    await w().getByRole("button", { name: /^All Assets/ }).first().click();
    const kyoto = (await rows()).find((row) => row.image_path.endsWith("Folders_c.jpg"));
    await w().locator(`[data-gallery-item='true'][data-asset-id='${kyoto.asset_id}']`).click();
    await expect(w().getByTestId("inspector-folder")).toHaveText("Kyoto");
    await w().getByTestId("inspector-folder").click();
    await expect(w().locator(".app-toolbar")).toContainText("Kyoto");
    await expect(galleryCards(w())).toHaveCount(1, { timeout: 15_000 });
    await expect(folderRow(path.join(year, "Kyoto"))).toHaveClass(/bg-selected/);
  });

  test("a folder moved in Finder is not found until it is located, then its photos follow", async () => {
    const moved = path.join(root, "Archive", "2026");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(year, moved);

    await openMenu(year);
    await menuItem("sync").click();
    await expect(w().getByText("Synced “2026”")).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(year)).toHaveAttribute("data-missing", "true", { timeout: 15_000 });

    await ctx.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, moved);
    await openMenu(year);
    await menuItem("locate").click();
    await expect(w().getByText("4 photos relinked")).toBeVisible({ timeout: 15_000 });
    year = moved;
    await expect(folderRow(year)).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(year)).not.toHaveAttribute("data-missing", "true");
    expect((await rows()).every((row) => row.image_path.startsWith(moved) && row.exists_on_disk)).toBe(true);
  });

  test("Save as Collection copies the folder into a collection, grouped by subfolder", async () => {
    await openMenu(year);
    await menuItem("save-collection").click();
    await w().locator("[data-choice='mirror']").click();
    await expect(w().getByText("Saved as the collection “2026”")).toBeVisible({ timeout: 15_000 });
    const collections = await w().evaluate(() => window.mediaWorkspace.listCollections());
    const made = collections.find((c) => c.name === "2026" && c.kind === "manual");
    expect(made).toBeTruthy();
    expect(collections.filter((c) => c.parent_collection_id === made.collection_id).map((c) => c.name).sort()).toEqual(["Kyoto", "Tokyo"]);
  });

  test("auto-sync: a shoot moved into the folder comes in by itself", async () => {
    test.setTimeout(120_000);
    await openMenu(year);
    await menuItem("auto-sync").click();
    await expect(folderRow(year).locator("[data-auto-synced]")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => w().evaluate(() => window.mediaWorkspace.getWatchedDirs()), { timeout: 10_000 }).toContain(year);

    const outside = path.join(root, "Osaka");
    fs.mkdirSync(outside);
    await writeUniqueJpeg(path.join(outside, "Folders_e.jpg"));
    await new Promise((resolve) => setTimeout(resolve, 500)); // FSEvents is watching by now
    fs.renameSync(outside, path.join(year, "Osaka"));

    await expect.poll(async () => (await rows()).some((row) => row.image_path === path.join(year, "Osaka", "Folders_e.jpg")), {
      timeout: 60_000, intervals: [500],
    }).toBe(true);
    await importDone();
    await expect(folderRow(year).locator("span.tabular-nums")).toHaveText("5", { timeout: 15_000 });
  });

  test("Remove from Library takes a folder's photos out, after a choice", async () => {
    const tokyo = path.join(year, "Tokyo");
    if (!(await folderRow(tokyo).count())) await expand(year);
    await openMenu(tokyo);
    await menuItem("remove").click();
    await expect(w().getByText("Remove “Tokyo” from the library?")).toBeVisible();
    await expect(w().getByText("2 photos are in it and the folders inside.")).toBeVisible();
    await w().locator("[data-choice='library']").click();
    await expect(w().getByText("2 photos removed from the library")).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(tokyo)).toHaveCount(0, { timeout: 15_000 });
    // Nothing on disk changed.
    expect(fs.existsSync(path.join(tokyo, "Folders_a.jpg"))).toBe(true);
    expect((await rows()).length).toBe(3);
  });
});
