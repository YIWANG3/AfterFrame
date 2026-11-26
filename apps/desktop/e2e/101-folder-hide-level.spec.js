// Folders on disk: hiding a level (docs/collections-and-folders-design.md
// §5.1). The tree folds down to the first folder that holds photos or leads
// to more than one; a top folder that only leads to others can be hidden by
// hand, Lightroom's Hide This Parent, and its folders take its place at the
// top. The choice is remembered, and Show the Level Above brings it back.
//
// Only fresh temp files are used; the committed fixtures are never touched.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, importThroughToolbar, galleryCards } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

test.describe("folders on disk: hiding a level", () => {
  test.describe.configure({ mode: "serial" });
  let ctx, root, shoots, trips, work;

  const w = () => ctx.window;
  // A backslash starts a CSS escape: a Windows path has its own doubled.
  const css = (value) => value.replace(/[\\"]/g, "\\$&");
  const folderRow = (dir) => w().locator(`[data-disk-folder="${css(dir)}"]`);
  const menu = () => w().getByTestId("sidebar-disk-folder-menu");
  const menuItem = (key) => menu().locator(`[data-menu-item='${key}']`);
  const openMenu = async (dir) => {
    await folderRow(dir).scrollIntoViewIfNeeded();
    await folderRow(dir).click({ button: "right" });
    await expect(menu()).toBeVisible();
  };
  const closeMenu = async () => {
    await w().keyboard.press("Escape");
    await expect(menu()).toHaveCount(0);
  };
  const ours = async () => (await w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })))
    .filter((row) => String(row.image_path || "").startsWith(root));

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-hide-level-")));
    shoots = path.join(root, "Shoots");
    trips = path.join(shoots, "Trips");
    work = path.join(shoots, "Work");
    fs.mkdirSync(trips, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    await writeUniqueJpeg(path.join(trips, "HideLevel_a.jpg"));
    await writeUniqueJpeg(path.join(work, "HideLevel_b.jpg"));
    ctx = await launchApp({ testName: "folder-hide-level" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await importThroughToolbar(ctx.app, w(), [shoots]);
    await expect.poll(async () => (await ours()).length, { timeout: 90_000 }).toBe(2);
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("a top folder that only leads to others hides, and its folders move up", async () => {
    // Shoots holds no photo itself and leads to two folders: the fold stops there.
    await expect(folderRow(shoots)).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(shoots).locator("span.tabular-nums")).toHaveText("2");
    await expect(folderRow(trips)).toHaveCount(0);

    await openMenu(shoots);
    await expect(menuItem("show-level")).toHaveCount(0);
    await menuItem("hide-level").click();

    await expect(folderRow(shoots)).toHaveCount(0);
    await expect(folderRow(trips)).toBeVisible();
    await expect(folderRow(work)).toBeVisible();
    // At the top now, where Shoots was.
    await expect(folderRow(trips)).toHaveCSS("padding-left", "10px");

    // A folder with photos of its own is no level to hide.
    await openMenu(trips);
    await expect(menuItem("hide-level")).toHaveCount(0);
    await expect(menuItem("show-level")).toBeVisible();
    await closeMenu();
  });

  test("the hidden level is remembered", async () => {
    await w().reload();
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(trips)).toBeVisible({ timeout: 15_000 });
    await expect(folderRow(shoots)).toHaveCount(0);
  });

  test("Show the Level Above brings it back", async () => {
    await openMenu(work);
    await menuItem("show-level").click();
    await expect(folderRow(shoots)).toBeVisible();
    await expect(folderRow(shoots).locator("span.tabular-nums")).toHaveText("2");
    // Back under it, folded away until it is opened.
    await expect(folderRow(trips)).toHaveCount(0);
    await expect(folderRow(work)).toHaveCount(0);
  });
});
