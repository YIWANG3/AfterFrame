// Moved originals keep their records (docs/collections-and-folders-design.md
// §5.5). A shoot moved in Finder and imported again from its new place is
// the same photos, not copies: the import finds each file's old record (same
// content, old path gone) and relinks it, so the rating and the folder stay,
// and says how many it found. A RAW+JPG pair comes back as the same pair.
// The Missing view's Relink All from Folder brings a photo's paired RAW
// along, and counts the pair once.
//
// Only fresh temp files are moved; the committed fixtures are only copied.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, importThroughToolbar, galleryCards } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

const RAW_FIXTURES = path.resolve(__dirname, "fixtures", "raw");

test.describe("moved originals", () => {
  test.describe.configure({ mode: "serial" });
  let ctx, root, shoot;
  let ids = {};
  let folderId;

  const w = () => ctx.window;
  const cardById = (id) => w().locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  // This spec's photos as the gallery lists them (the seeded catalog has others).
  const rows = async () => (await w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })))
    .filter((row) => String(row.image_path || "").startsWith(root));
  const rowById = async (id) => (await rows()).find((row) => row.asset_id === id) || null;
  const folderMembers = () => w().evaluate(
    (id) => window.mediaWorkspace.browseCollection(id, { limit: 1000, offset: 0 }).then((list) => list.map((row) => row.asset_id)),
    folderId,
  );
  const importDone = () => expect.poll(
    () => w().evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)),
    { timeout: 60_000, intervals: [250] },
  ).toBe(false);
  const moveShoot = (to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(shoot, to);
    shoot = to;
  };

  test.beforeAll(async () => {
    test.setTimeout(150_000); // launch + an import with a RAW, slower on CI
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-moved-")));
    shoot = path.join(root, "Shoot");
    fs.mkdirSync(shoot);
    await writeUniqueJpeg(path.join(shoot, "Moved_a.jpg"));
    // A camera's RAW+JPEG of one shot.
    fs.copyFileSync(path.join(RAW_FIXTURES, "luna-morning.dng"), path.join(shoot, "DSC_0001.DNG"));
    fs.copyFileSync(path.join(RAW_FIXTURES, "luna-morning.jpg"), path.join(shoot, "DSC_0001.JPG"));
    ctx = await launchApp({ testName: "moved-originals" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });

    await importThroughToolbar(ctx.app, w(), [shoot]);
    await expect.poll(async () => (await rows()).length, { timeout: 90_000 }).toBe(2);
    await importDone();
    const byName = new Map((await rows()).map((row) => [path.basename(row.image_path), row]));
    ids = {
      a: byName.get("Moved_a.jpg").asset_id,
      pair: byName.get("DSC_0001.JPG").asset_id,
      raw: byName.get("DSC_0001.JPG").pair_raw_asset_id,
    };
    expect(ids.raw, "the RAW+JPG shot should be one photo").toBeTruthy();

    // a is rated and filed: both have to come along.
    await cardById(ids.a).scrollIntoViewIfNeeded();
    await cardById(ids.a).click();
    await w().keyboard.press("4");
    await expect(w().getByTestId("inspector-rating")).toHaveAttribute("data-value", "4");
    folderId = (await w().evaluate(() => window.mediaWorkspace.createCollection("Moved", "manual"))).collection_id;
    await w().evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folderId, asset: ids.a });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("a shoot moved in Finder and imported again is the same photos, not copies", async () => {
    test.setTimeout(120_000);
    moveShoot(path.join(root, "Archive", "2026", "Shoot"));

    await importThroughToolbar(ctx.app, w(), [path.join(root, "Archive")]);

    // The photo, the JPG and its RAW: three files found, nothing new.
    await expect(w().getByText("Found 3 moved files")).toBeVisible({ timeout: 60_000 });
    await expect(w().getByText("Their records came along: ratings, tags and collections are kept.")).toBeVisible();
    await importDone();
    await expect(w().getByText(/already in catalog/)).toHaveCount(0);

    const after = await rows();
    expect(after.map((row) => row.asset_id).sort()).toEqual([ids.a, ids.pair].sort());
    const a = await rowById(ids.a);
    expect(a.image_path).toBe(path.join(shoot, "Moved_a.jpg"));
    expect(a.exists_on_disk).toBe(true);
    expect(a.app_rating).toBe(4);
    expect(await folderMembers()).toEqual([ids.a]);
    const pair = await rowById(ids.pair);
    expect(pair.image_path).toBe(path.join(shoot, "DSC_0001.JPG"));
    expect(pair.pair_raw_asset_id).toBe(ids.raw);
    expect(pair.pair_raw_path).toBe(path.join(shoot, "DSC_0001.DNG"));
  });

  test("Relink All from Folder brings a photo's paired RAW along and counts the pair once", async () => {
    test.setTimeout(120_000);
    const backup = path.join(root, "Backup");
    moveShoot(path.join(backup, "Shoot"));

    const clicked = await ctx.app.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      const item = file?.submenu?.items.find((entry) => entry.label === "Verify Files");
      if (!item) return false;
      const win = BrowserWindow.getAllWindows()[0];
      item.click(undefined, win, win?.webContents);
      return true;
    });
    expect(clicked, "File › Verify Files should exist in the application menu").toBe(true);
    await expect(w().getByText(/files? missing/)).toBeVisible({ timeout: 15_000 });
    await w().getByRole("button", { name: "View", exact: true }).click();
    await expect(w().locator("[data-filter-bar]").getByRole("button", { name: "Missing", exact: true })).toBeVisible();
    await expect(cardById(ids.a)).toBeVisible({ timeout: 15_000 });
    await expect(cardById(ids.pair)).toBeVisible();

    await ctx.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, backup);
    await w().getByTestId("missing-files-bar").getByRole("button", { name: "Relink All from Folder…" }).click();

    await expect(w().getByText("2 photos relinked")).toBeVisible({ timeout: 15_000 });
    await expect(galleryCards(w())).toHaveCount(0, { timeout: 15_000 });
    const pair = await rowById(ids.pair);
    expect(pair.image_path).toBe(path.join(shoot, "DSC_0001.JPG"));
    expect(pair.pair_raw_path).toBe(path.join(shoot, "DSC_0001.DNG"));
    expect((await rowById(ids.a)).app_rating).toBe(4);
  });
});
