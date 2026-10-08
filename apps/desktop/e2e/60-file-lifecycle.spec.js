// A photo's life after import (docs/review/2026-10-04-AfterFrame文件生命周期与E2E缺口.md):
// its original is moved, trashed, put back or relinked outside the app, and
// the app itself removes or trashes it. Driven the way a user drives it:
// files change on disk the way Finder changes them (rename, move), the app
// hears about it through the toolbar's Refresh, the Inspector's Relink button
// (the native picker answered in the main process) and the gallery's context
// menu. Every step checks the file on disk, the card, the Inspector, the
// rating, the folder and the preview together: an unchanged asset id alone
// does not show that a record's metadata came back.
//
// The photo stays selected through each sequence. Re-selecting it would hide
// exactly the bug this guards: an Inspector still showing the old path and
// the old missing state after the card had updated.
//
// Only fresh temp copies are moved or deleted; the committed fixtures are
// never touched. Nothing here waits on fs-watch events (17-watched-dirs, which
// the CI VM cannot run): the watched-folder catch-up is the startup scan.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, collectCoverage, byImagePath, importThroughToolbar } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

function makeDirs(prefix, ...names) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const dirs = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { root, ...dirs };
}

function harness(ctx) {
  const w = () => ctx.window;
  const h = {
    card: (filePath) => w().locator(`[data-gallery-item='true']${byImagePath(filePath)}`),
    cardById: (assetId) => w().locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`),
    missingBadge: (card) => card.locator("[title='Original file moved or deleted']"),
    inspectorTitle: () => w().getByTestId("inspector-asset-title"),
    inspectorMissing: () => w().getByTestId("inspector-missing"),
    inspectorPath: () => w().getByTestId("inspector-source-path"),
    inspectorRating: () => w().getByTestId("inspector-rating"),
    refresh: () => w().locator(".app-toolbar button[title='Refresh']").click(),
    stubOpenDialog: (paths) => ctx.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
    }, paths),
    importThroughPicker: (paths) => importThroughToolbar(ctx.app, w(), paths),
    rows: () => w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 })),
    async rowAt(filePath) {
      return (await h.rows()).find((row) => row.image_path === filePath) || null;
    },
    async rowById(assetId) {
      return (await h.rows()).find((row) => row.asset_id === assetId) || null;
    },
    assetCount: () => w().evaluate(() => window.mediaWorkspace.getSummary().then((s) => s.browse_assets)),
    folderMembers: (collectionId) => w().evaluate(
      (id) => window.mediaWorkspace.browseCollection(id, { limit: 1000, offset: 0 }).then((rows) => rows.map((row) => row.asset_id)),
      collectionId,
    ),
    async waitForImportIdle() {
      await expect.poll(() => w().evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), {
        timeout: 30_000, intervals: [250],
      }).toBe(false);
    },
    // The preview the gallery shows for this record, decoded.
    async previewDecodes(card) {
      await expect.poll(() => card.locator("img").first().evaluate((img) => img.complete && img.naturalWidth > 0), {
        timeout: 10_000,
      }).toBe(true);
    },
  };
  return h;
}

test.describe("a selected photo whose original moves, is trashed and comes back", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = {};
  const h = harness(ctx);
  let dirs, original, assetId, folderId, baseline;

  test.beforeAll(async () => {
    test.setTimeout(120_000); // launch + an import, slower on CI
    dirs = makeDirs("afterframe-e2e-lifecycle-", "A", "B", "Trash");
    original = path.join(dirs.A, "Lifecycle_external.jpg");
    await writeUniqueJpeg(original);
    Object.assign(ctx, await launchApp({ testName: "file-lifecycle" }));
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });

    await h.importThroughPicker([original]);
    await expect(h.card(original)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    assetId = await h.card(original).getAttribute("data-asset-id");

    // Rated and filed through the UI's own paths: the keyboard and a folder.
    await h.card(original).click();
    await expect(h.inspectorTitle()).toHaveText(path.basename(original));
    await ctx.window.keyboard.press("4");
    await expect(h.inspectorRating()).toHaveAttribute("data-value", "4");
    folderId = (await ctx.window.evaluate(() => window.mediaWorkspace.createCollection("Lifecycle", "manual"))).collection_id;
    await ctx.window.evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folderId, asset: assetId });
    baseline = await h.assetCount();
  });

  test.afterAll(async () => {
    await closeApp(ctx.app, ctx.userDataDir);
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  // The record as the catalog holds it, and what the screen says about it.
  async function expectRecord({ at, missing, rating = 4, inFolder = true }) {
    const row = await h.rowById(assetId);
    expect(row.image_path).toBe(at);
    expect(row.exists_on_disk).toBe(!missing);
    expect(row.app_rating).toBe(rating);
    expect((await h.folderMembers(folderId)).includes(assetId)).toBe(inFolder);
    expect(await h.assetCount()).toBe(baseline);

    const card = h.cardById(assetId);
    await expect(h.missingBadge(card)).toHaveCount(missing ? 1 : 0, { timeout: 10_000 });
    await expect(card).toHaveAttribute("data-image-path", at);
    await h.previewDecodes(card);
    // Same photo still selected — the Inspector has to have followed.
    await expect(card).toHaveAttribute("data-selected", "true");
    await expect(h.inspectorMissing()).toHaveCount(missing ? 1 : 0, { timeout: 10_000 });
    await expect(h.inspectorPath()).toHaveAttribute("data-path", at);
    await expect(h.inspectorPath()).toHaveAttribute("data-missing", String(missing));
    await expect(ctx.window.getByRole("button", { name: /^Relink$/ })).toHaveCount(missing ? 1 : 0);
    await expect(h.inspectorRating()).toHaveAttribute("data-value", String(rating));
  }

  async function expectEditorBlocked() {
    await ctx.window.keyboard.press("e");
    await expect(ctx.window.getByText("Original file missing")).toBeVisible({ timeout: 5_000 });
    expect(await ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen())).toBe(false);
  }

  async function expectEditorOpens() {
    await ctx.window.keyboard.press("e");
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen())).toBe(true);
    await ctx.window.evaluate(() => window.__afterframeTest.closeEditor());
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen())).toBe(false);
  }

  test("moved to another folder: after Refresh the card and the open Inspector both say Missing", async () => {
    await h.cardById(assetId).click();
    await expectRecord({ at: original, missing: false });

    const moved = path.join(dirs.B, path.basename(original));
    fs.renameSync(original, moved);
    await h.refresh();
    await expectRecord({ at: original, missing: true });
    await expectEditorBlocked();
    // The photo is not followed to its new folder.
    expect(await h.rowAt(moved)).toBeNull();
  });

  test("moved back to the same path: the record, its rating and its folder are usable again", async () => {
    fs.renameSync(path.join(dirs.B, path.basename(original)), original);
    await h.refresh();
    await expectRecord({ at: original, missing: false });
    await expectEditorOpens();
  });

  test("trashed outside the app and put back: missing in between, the same record after", async () => {
    // Finder's Move to Trash and Put Back, as far as the app can tell: the
    // path disappears, then the same bytes come back to it.
    const trashed = path.join(dirs.Trash, path.basename(original));
    fs.renameSync(original, trashed);
    await h.refresh();
    await expectRecord({ at: original, missing: true });

    fs.renameSync(trashed, original);
    await h.refresh();
    await expectRecord({ at: original, missing: false });
  });

  test("moved, then relinked through the Inspector's picker: same record at the new path", async () => {
    const moved = path.join(dirs.B, path.basename(original));
    fs.renameSync(original, moved);
    await h.refresh();
    await expectRecord({ at: original, missing: true });

    await h.stubOpenDialog([moved]);
    await ctx.window.getByRole("button", { name: /^Relink$/ }).click();
    await expect(ctx.window.getByText("Original file reconnected.")).toBeVisible({ timeout: 10_000 });
    await expectRecord({ at: moved, missing: false });
    await expectEditorOpens();
  });

  test("relinking onto a file the catalog already holds is refused and changes nothing", async () => {
    const current = path.join(dirs.B, path.basename(original));
    const renamed = path.join(dirs.B, "Lifecycle_external_renamed.jpg");
    fs.renameSync(current, renamed);
    // Importing the renamed file makes a second record; the rating and the
    // folder stay with the first one (the app does not follow renames).
    await h.importThroughPicker([renamed]);
    await expect(h.card(renamed)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    baseline += 1;
    const other = await h.rowAt(renamed);
    expect(other.asset_id).not.toBe(assetId);
    expect(other.app_rating ?? null).toBeNull();
    expect((await h.folderMembers(folderId)).includes(other.asset_id)).toBe(false);

    await h.cardById(assetId).click();
    await h.refresh();
    await expectRecord({ at: current, missing: true });

    await h.stubOpenDialog([renamed]);
    await ctx.window.getByRole("button", { name: /^Relink$/ }).click();
    await expect(ctx.window.getByText(/already belongs to another item in the catalog/)).toBeVisible({ timeout: 10_000 });
    await expectRecord({ at: current, missing: true });
    const otherAfter = await h.rowAt(renamed);
    expect(otherAfter.asset_id).toBe(other.asset_id);
    expect(otherAfter.app_rating ?? null).toBeNull();
    expect(otherAfter.exists_on_disk).toBe(true);
    expect(fs.existsSync(renamed)).toBe(true);
  });
});

// A watched folder, so the startup scan has something to scan. The folder is
// added through the same IPC as Settings, whose first import is sent from the
// main process directly: nothing in this block waits on an fs-watch event.
test.describe("removed from the library, deleted from disk, changed while the app was closed", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = {};
  const h = harness(ctx);
  let dirs, files, folderId;
  const ids = {};

  test.beforeAll(async () => {
    test.setTimeout(120_000); // launch + an import, slower on CI
    dirs = makeDirs("afterframe-e2e-lifecycle-watch-", "W/A", "W/B", "Trash");
    files = {
      catalog: path.join(dirs["W/A"], "Lifecycle_catalog.jpg"),
      trash: path.join(dirs["W/A"], "Lifecycle_trash.jpg"),
      watch: path.join(dirs["W/A"], "Lifecycle_watch.jpg"),
    };
    for (const file of Object.values(files)) await writeUniqueJpeg(file);
    Object.assign(ctx, await launchApp({ testName: "file-lifecycle-watch" }));
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });

    await ctx.window.evaluate((dir) => window.mediaWorkspace.addWatchedDir(dir), path.dirname(dirs["W/A"]));
    for (const file of Object.values(files)) await expect(h.card(file)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();

    folderId = (await ctx.window.evaluate(() => window.mediaWorkspace.createCollection("Lifecycle", "manual"))).collection_id;
    for (const [key, stars] of [["catalog", 3], ["trash", 2], ["watch", 1]]) {
      ids[key] = await h.card(files[key]).getAttribute("data-asset-id");
      await h.card(files[key]).click();
      await expect(h.inspectorTitle()).toHaveText(path.basename(files[key]));
      await ctx.window.keyboard.press(String(stars));
      await expect(h.inspectorRating()).toHaveAttribute("data-value", String(stars));
    }
    await ctx.window.evaluate(({ id, assets }) => window.mediaWorkspace.collectionAddItems(id, assets), { id: folderId, assets: Object.values(ids) });
  });

  test.afterAll(async () => {
    await closeApp(ctx.app, ctx.userDataDir);
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  async function contextMenu(file, item) {
    await h.card(file).click();
    await h.card(file).click({ button: "right" });
    await ctx.window.getByText(item, { exact: true }).click();
  }

  test("Delete from Catalog keeps the file and drops the record with its rating and folder entry", async () => {
    const before = await h.assetCount();
    await contextMenu(files.catalog, "Delete from Catalog");
    await expect(ctx.window.getByText("Original files aren't deleted — only the catalog records.")).toBeVisible();
    await ctx.window.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(h.card(files.catalog)).toHaveCount(0, { timeout: 10_000 });
    expect(fs.existsSync(files.catalog)).toBe(true);
    expect(await h.rowAt(files.catalog)).toBeNull();
    expect(await h.folderMembers(folderId)).not.toContain(ids.catalog);
    expect(await h.assetCount()).toBe(before - 1);
  });

  test("Delete from Disk: Cancel changes nothing, Move to Trash removes the file and the record", async () => {
    const before = await h.assetCount();
    await contextMenu(files.trash, "Delete from Disk…");
    await ctx.window.getByRole("button", { name: "Cancel" }).click();
    expect(fs.existsSync(files.trash)).toBe(true);
    expect((await h.rowAt(files.trash)).app_rating).toBe(2);
    expect(await h.folderMembers(folderId)).toContain(ids.trash);

    const bytes = fs.readFileSync(files.trash);
    await contextMenu(files.trash, "Delete from Disk…");
    await ctx.window.getByRole("button", { name: "Move to Trash" }).click();
    await expect(h.card(files.trash)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => fs.existsSync(files.trash), { timeout: 10_000 }).toBe(false);
    expect(await h.rowAt(files.trash)).toBeNull();
    expect(await h.folderMembers(folderId)).not.toContain(ids.trash);
    expect(await h.assetCount()).toBe(before - 1);
    // Finder's Put Back, as the app sees it: the same bytes at the same path.
    fs.writeFileSync(files.trash, bytes);
  });

  test("after a restart the scan imports what is new or put back, and keeps a removed file out", async () => {
    // A relaunch, the startup scan and an import: well over the default 60 s
    // on a busy machine.
    test.setTimeout(180_000);
    // While the app is closed, the 1-star photo is renamed into the other folder.
    await collectCoverage(ctx.app);
    await ctx.app.close();
    const moved = path.join(dirs["W/B"], "Lifecycle_watch_restart.jpg");
    fs.renameSync(files.watch, moved);
    Object.assign(ctx, await launchApp({ testName: "file-lifecycle-watch", reuseUserDataDir: ctx.userDataDir, keepCatalog: true }));

    await expect(h.card(moved)).toBeVisible({ timeout: 30_000 });
    await expect(h.card(files.trash)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();

    // The renamed file is a new record; the rating and the folder stayed on
    // the old one, which is now missing.
    const fresh = await h.rowAt(moved);
    expect(fresh.asset_id).not.toBe(ids.watch);
    expect(fresh.app_rating ?? null).toBeNull();
    expect(await h.folderMembers(folderId)).not.toContain(fresh.asset_id);
    await h.previewDecodes(h.card(moved));
    const old = await h.rowById(ids.watch);
    expect(old.image_path).toBe(files.watch);
    expect(old.exists_on_disk).toBe(false);
    expect(old.app_rating).toBe(1);
    expect(await h.folderMembers(folderId)).toContain(ids.watch);
    await expect(h.missingBadge(h.cardById(ids.watch))).toHaveCount(1);

    // Put back after Delete from Disk: in again, as a photo the catalog has
    // never seen. The id may well repeat; the rating and the folder do not.
    const putBack = await h.rowAt(files.trash);
    expect(putBack.exists_on_disk).toBe(true);
    expect(putBack.app_rating ?? null).toBeNull();
    expect(await h.folderMembers(folderId)).not.toContain(putBack.asset_id);
    await h.previewDecodes(h.card(files.trash));

    // Removed from the catalog, still on disk, unchanged: the scan leaves it out.
    expect(fs.existsSync(files.catalog)).toBe(true);
    expect(await h.rowAt(files.catalog)).toBeNull();
    const scan = await ctx.window.evaluate((dir) => window.mediaWorkspace.scanNewMedia([dir]), path.dirname(dirs["W/A"]));
    expect(scan.new_files).not.toContain(files.catalog);
    await expect(h.card(files.catalog)).toHaveCount(0);
  });

  test("importing the removed file on purpose brings it back, without its old rating or folder", async () => {
    test.setTimeout(120_000);
    await h.importThroughPicker([files.catalog]);
    await expect(h.card(files.catalog)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    const back = await h.rowAt(files.catalog);
    expect(back.exists_on_disk).toBe(true);
    expect(back.app_rating ?? null).toBeNull();
    expect(await h.folderMembers(folderId)).not.toContain(back.asset_id);
    await h.previewDecodes(h.card(files.catalog));
    await h.card(files.catalog).click();
    await expect(h.inspectorPath()).toHaveAttribute("data-path", files.catalog);
    await expect(h.inspectorRating()).toHaveAttribute("data-value", "0");
  });
});

// Live fs-watch events. Same constraint as 17-watched-dirs: the GitHub macOS
// VM delivers them too slowly and unevenly to assert on, so this runs locally
// only. The startup scan above is what CI checks.
test.describe("a watched folder while the app runs", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!process.env.CI, "fs-watch delivery on the GitHub macOS runner is too slow and uneven to assert on");
  const ctx = {};
  const h = harness(ctx);
  let dirs, first, assetId, folderId;

  test.beforeAll(async () => {
    test.setTimeout(120_000); // launch + an import, slower on CI
    dirs = makeDirs("afterframe-e2e-lifecycle-live-", "W/A", "W/B", "Trash");
    first = path.join(dirs["W/A"], "Lifecycle_live.jpg");
    await writeUniqueJpeg(first);
    Object.assign(ctx, await launchApp({ testName: "file-lifecycle-live" }));
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
    await ctx.window.evaluate((dir) => window.mediaWorkspace.addWatchedDir(dir), path.dirname(dirs["W/A"]));
    await expect(h.card(first)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    assetId = await h.card(first).getAttribute("data-asset-id");
    await h.card(first).click();
    await expect(h.inspectorTitle()).toHaveText(path.basename(first));
    await ctx.window.keyboard.press("5");
    await expect(h.inspectorRating()).toHaveAttribute("data-value", "5");
    folderId = (await ctx.window.evaluate(() => window.mediaWorkspace.createCollection("Lifecycle", "manual"))).collection_id;
    await ctx.window.evaluate(({ id, asset }) => window.mediaWorkspace.collectionAddItems(id, [asset]), { id: folderId, asset: assetId });
  });

  test.afterAll(async () => {
    await closeApp(ctx.app, ctx.userDataDir);
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  test("a rename and a move across folders import new records; the old one keeps its rating, missing", async () => {
    test.setTimeout(150_000);
    const renamed = path.join(dirs["W/A"], "Lifecycle_live_renamed.jpg");
    fs.renameSync(first, renamed);
    await expect(h.card(renamed)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    const afterRename = await h.rowAt(renamed);
    expect(afterRename.asset_id).not.toBe(assetId);
    expect(afterRename.app_rating ?? null).toBeNull();

    const moved = path.join(dirs["W/B"], "Lifecycle_live_renamed.jpg");
    fs.renameSync(renamed, moved);
    await expect(h.card(moved)).toBeVisible({ timeout: 30_000 });
    await h.waitForImportIdle();
    expect((await h.rowAt(moved)).app_rating ?? null).toBeNull();

    await h.refresh();
    const old = await h.rowById(assetId);
    expect(old.exists_on_disk).toBe(false);
    expect(old.app_rating).toBe(5);
    expect(await h.folderMembers(folderId)).toEqual([assetId]);
    expect((await h.rowAt(renamed)).exists_on_disk).toBe(false);
    await expect(h.missingBadge(h.cardById(assetId))).toHaveCount(1);
  });

  test("deleted and put back while selected: the watcher brings the same record back and the Inspector follows", async () => {
    test.setTimeout(120_000);
    const moved = path.join(dirs["W/B"], "Lifecycle_live_renamed.jpg");
    const record = (await h.rowAt(moved)).asset_id;
    await h.cardById(record).click();
    await expect(h.inspectorPath()).toHaveAttribute("data-path", moved);
    await ctx.window.keyboard.press("2");
    await expect(h.inspectorRating()).toHaveAttribute("data-value", "2");

    const trashed = path.join(dirs.Trash, path.basename(moved));
    fs.renameSync(moved, trashed);
    await h.refresh();
    await expect(h.inspectorMissing()).toHaveCount(1, { timeout: 10_000 });

    // Put back, then no manual Refresh: the watcher is the only thing that
    // tells the app. The catalog holds the file as it is (browsing never
    // recorded it missing), so nothing is imported; the card and the
    // Inspector that saw it gone check again.
    fs.renameSync(trashed, moved);
    await expect(h.missingBadge(h.cardById(record))).toHaveCount(0, { timeout: 30_000 });
    await expect(h.inspectorMissing()).toHaveCount(0, { timeout: 10_000 });
    await expect(h.inspectorPath()).toHaveAttribute("data-missing", "false");
    await expect(h.inspectorRating()).toHaveAttribute("data-value", "2");
    const row = await h.rowAt(moved);
    expect(row.asset_id).toBe(record);
    expect(row.app_rating).toBe(2);
    await h.previewDecodes(h.cardById(record));
  });
});
