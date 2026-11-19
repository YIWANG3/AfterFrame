// Missing originals, handled in bulk: photos whose files were moved or
// deleted in Finder gather in a gallery view of their own (Missing
// Originals), opened from File ▸ Verify Files' toast and from the stats
// page's "Missing from disk" row. There the user relinks them from a folder
// (each original looked for by name, linked only when its content matches,
// the record kept: same id, rating, folder) or removes them from the library
// after a confirm. Opening or refreshing the view checks the disk again, so a
// file put back where it was leaves it; once every photo is relinked or
// removed the view is empty. The bar's actions take a multi-selection, else
// the whole view (one photo is always selected, the Inspector's).
//
// Only fresh temp files are moved or deleted; the committed fixtures are
// never touched.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, byImagePath, importThroughToolbar, galleryCards, callToolOk, waitForMcp } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

test.describe("the Missing Originals view", () => {
  test.describe.configure({ mode: "serial" });
  let ctx, root, library, moved;
  const files = {};
  const ids = {};
  let folderId;
  let savedE;

  const w = () => ctx.window;
  const card = (file) => w().locator(`[data-gallery-item='true']${byImagePath(file)}`);
  const cardById = (id) => w().locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  const bar = () => w().getByTestId("missing-files-bar");
  const rows = () => w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 }));
  const rowById = async (id) => (await rows()).find((row) => row.asset_id === id) || null;
  const folderMembers = () => w().evaluate(
    (id) => window.mediaWorkspace.browseCollection(id, { limit: 1000, offset: 0 }).then((list) => list.map((row) => row.asset_id)),
    folderId,
  );
  const stubFolderPicker = (dir) => ctx.app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
  }, dir);
  const expectShowing = async (names) => {
    await expect(galleryCards(w())).toHaveCount(names.length, { timeout: 15_000 });
    for (const name of names) await expect(cardById(ids[name])).toBeVisible();
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000); // launch + an import, slower on CI
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-missing-")));
    library = path.join(root, "Library");
    moved = path.join(root, "Backup");
    fs.mkdirSync(library);
    fs.mkdirSync(path.join(moved, "2026", "Trip"), { recursive: true });
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      files[name] = await writeUniqueJpeg(path.join(library, `Missing_${name}.jpg`));
    }
    ctx = await launchApp({ testName: "missing-files" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });

    await importThroughToolbar(ctx.app, w(), Object.values(files));
    for (const file of Object.values(files)) await expect(card(file)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => w().evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), {
      timeout: 30_000, intervals: [250],
    }).toBe(false);
    for (const [name, file] of Object.entries(files)) ids[name] = await card(file).getAttribute("data-asset-id");

    // a is rated and filed: both have to survive the relink.
    await card(files.a).click();
    await w().keyboard.press("4");
    await expect(w().getByTestId("inspector-rating")).toHaveAttribute("data-value", "4");
    folderId = (await w().evaluate(() => window.mediaWorkspace.createCollection("Missing", "manual"))).collection_id;
    await w().evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folderId, asset: ids.a });

    // What Finder did: a and b moved into a backup (b two folders down),
    // c deleted with an unrelated file of its name left in the backup, d, e
    // and f deleted.
    fs.renameSync(files.a, path.join(moved, path.basename(files.a)));
    fs.renameSync(files.b, path.join(moved, "2026", "Trip", path.basename(files.b)));
    fs.rmSync(files.c);
    await writeUniqueJpeg(path.join(moved, path.basename(files.c)));
    fs.rmSync(files.d);
    savedE = fs.readFileSync(files.e);
    fs.rmSync(files.e);
    fs.rmSync(files.f);
  });

  test.afterAll(async () => {
    await closeApp(ctx.app, ctx.userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("File ▸ Verify Files says how many are missing, and View opens them", async () => {
    const clicked = await ctx.app.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      const item = file?.submenu?.items.find((entry) => entry.label === "Verify Files");
      if (!item) return false;
      const win = BrowserWindow.getAllWindows()[0];
      item.click(undefined, win, win?.webContents);
      return true;
    });
    expect(clicked, "File › Verify Files should exist in the application menu").toBe(true);
    await expect(w().getByText("6 files missing")).toBeVisible({ timeout: 15_000 });
    await w().getByRole("button", { name: "View", exact: true }).click();

    await expect(w().locator(".app-toolbar")).toContainText("Missing Originals");
    await expectShowing(["a", "b", "c", "d", "e", "f"]);
    await expect(cardById(ids.a).locator("[title='Original file moved or deleted']")).toHaveCount(1);
    await expect(bar()).toContainText("Relink All from Folder…");
    await expect(bar()).toContainText("Remove All from Library…");
  });

  test("Relink All from Folder links what matches by name and content, and says what it couldn't", async () => {
    await stubFolderPicker(moved);
    await bar().getByRole("button", { name: "Relink All from Folder…" }).click();

    await expect(w().getByText("2 photos relinked")).toBeVisible({ timeout: 15_000 });
    await expect(w().getByText("3 not found · 1 same-named file didn't match, not linked")).toBeVisible();
    await expectShowing(["c", "d", "e", "f"]);

    // The same records, at their new places, with their rating and folder.
    const a = await rowById(ids.a);
    expect(a.image_path).toBe(path.join(moved, path.basename(files.a)));
    expect(a.exists_on_disk).toBe(true);
    expect(a.app_rating).toBe(4);
    expect(await folderMembers()).toEqual([ids.a]);
    const b = await rowById(ids.b);
    expect(b.image_path).toBe(path.join(moved, "2026", "Trip", path.basename(files.b)));
    expect(b.exists_on_disk).toBe(true);
    // The stranger named like c was left alone.
    expect((await rowById(ids.c)).image_path).toBe(files.c);
  });

  test("a file put back where it was leaves the view on Refresh", async () => {
    fs.writeFileSync(files.e, savedE);
    await w().locator(".app-toolbar button[title='Refresh']").click();
    await expectShowing(["c", "d", "f"]);
    expect((await rowById(ids.e)).exists_on_disk).toBe(true);
  });

  test("Remove from Library acts on a multi-selection, after a confirm that says what goes", async () => {
    await cardById(ids.d).click();
    await expect(bar()).toContainText("Remove All from Library…");
    await cardById(ids.f).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await expect(bar()).toContainText("Relink 2 from Folder…");
    await bar().getByRole("button", { name: "Remove 2 from Library…" }).click();
    await expect(w().getByText("Remove these 2 missing photos from the library?")).toBeVisible();
    await expect(w().getByText("Their ratings, tags and collection places go with them. Nothing on disk changes.")).toBeVisible();
    await w().getByRole("button", { name: "Cancel" }).click();
    await expectShowing(["c", "d", "f"]);

    await bar().getByRole("button", { name: "Remove 2 from Library…" }).click();
    await w().getByRole("button", { name: "Remove", exact: true }).click();
    await expect(w().getByText("2 photos removed from the library")).toBeVisible({ timeout: 10_000 });
    await expectShowing(["c"]);
    expect(await rowById(ids.d)).toBeNull();
    expect(await rowById(ids.f)).toBeNull();
    expect(await rowById(ids.c)).not.toBeNull();
  });

  test("the stats page's Missing row opens the view; removing the last photo leaves it empty", async () => {
    await w().getByTestId("sidebar-stats").click();
    await expect(w().getByTestId("stats-view")).toBeVisible({ timeout: 10_000 });
    const row = w().locator("[data-cleanup='missing']");
    await expect(row).toContainText("1 photo");
    await row.click();

    await expect(w().getByTestId("stats-view")).toHaveCount(0);
    await expect(w().locator(".app-toolbar")).toContainText("Missing Originals");
    await expectShowing(["c"]);
    await bar().getByRole("button", { name: "Remove All from Library…" }).click();
    await w().getByRole("button", { name: "Remove", exact: true }).click();

    await expect(galleryCards(w())).toHaveCount(0, { timeout: 10_000 });
    await expect(w().getByText("No assets in this view")).toBeVisible();
    await expect(bar()).toHaveCount(0);
    expect(await rowById(ids.c)).toBeNull();
    // Removing touches nothing on disk: the unrelated file is still there.
    expect(fs.existsSync(path.join(moved, path.basename(files.c)))).toBe(true);
  });

  test("an agent sees the same: search_assets status missing, maintain_library relink_from_folder", async () => {
    await waitForMcp(ctx.mcpPort);
    const file = await writeUniqueJpeg(path.join(library, "Missing_agent.jpg"));
    await importThroughToolbar(ctx.app, w(), [file]);
    await expect.poll(async () => (await rows()).some((row) => row.image_path === file), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => w().evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), {
      timeout: 30_000, intervals: [250],
    }).toBe(false);
    const id = (await rows()).find((row) => row.image_path === file).asset_id;
    const elsewhere = path.join(root, "Elsewhere");
    fs.mkdirSync(elsewhere);
    fs.renameSync(file, path.join(elsewhere, path.basename(file)));

    const missing = await callToolOk(ctx.mcpPort, "search_assets", { status: "missing" });
    expect(missing.assets.map((asset) => asset.asset_id)).toEqual([id]);
    const result = await callToolOk(ctx.mcpPort, "maintain_library", { action: "relink_from_folder", dir: elsewhere });
    expect(result.relinked).toBe(1);
    expect(result.items).toEqual([{ asset_id: id, status: "relinked", new_path: path.join(elsewhere, path.basename(file)) }]);
    expect((await callToolOk(ctx.mcpPort, "search_assets", { status: "missing" })).assets).toEqual([]);
  });
});
