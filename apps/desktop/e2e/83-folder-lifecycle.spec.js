// A shoot as a folder, from the first drag to the last delete.
//
// A folder dragged in from Finder onto the sidebar's folders is imported like
// any other (its photos are in the library) and becomes a folder here of the
// same name, holding them; dropped on a folder row it lands inside that
// folder, and loose files dropped on a row go into it. Deleting a folder that
// is the only one holding some photos asks what becomes of them: they stay,
// they leave the library, or their files go to the Trash. A photo another
// folder holds too is never taken.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");
const { writeUniqueJpeg } = require("./helpers/images");

let ctx;
let work; // the folders on disk
const w = () => ctx.window;
const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const scroll = () => w().getByTestId("sidebar-folder-scroll");
const section = () => w().locator("[data-sidebar-folders='true']");
const row = (name) => scroll().locator("[data-collection-id]").filter({ has: w().locator("span.truncate", { hasText: new RegExp(`^${name}$`) }) });
const rowNames = () => scroll().locator("[data-collection-id]").evaluateAll((rows) => rows.map((r) => `${r.dataset.folderDepth}:${r.querySelector("span.truncate")?.textContent}`));
const cards = () => galleryCards(w());
const cardNames = () => cards().evaluateAll((els) => els.map((el) => el.dataset.imagePath.split(/[\\/]/).pop()).sort());
const folders = async () => {
  const { collections } = await callTool("manage_collections", { action: "list" });
  return Object.fromEntries(collections.filter((c) => c.kind === "manual").map((c) => [c.name, c]));
};
const libraryCount = () => w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 }).then((rows) => rows.length));
const namesIn = (folderName) => w().evaluate(async (name) => {
  const bridge = window.mediaWorkspace;
  const folder = (await bridge.listCollections()).find((c) => c.name === name);
  const rows = await bridge.browseCollection(folder.collection_id, { limit: 200 });
  return rows.map((r) => r.image_path.split(/[\\/]/).pop()).sort();
}, folderName);
const inLibrary = (file) => w().evaluate((p) => window.mediaWorkspace.getAssetDetail(p).then((d) => !!d?.asset_id).catch(() => false), file);

// Made the way a user makes one: the sidebar's New folder button.
async function newFolder(name) {
  await w().getByTitle("New folder", { exact: true }).click();
  const field = scroll().locator("input");
  await field.fill(name);
  await field.press("Enter");
  await expect(row(name)).toBeVisible({ timeout: 15_000 });
}

// A drag from Finder. Electron hands real drags to the OS, so the DOM events
// are dispatched; a File made in the page has no path on disk for the app to
// read, so the fallback it reads (`file.path`) answers with the one meant.
async function dropFromFinder(paths, target) {
  const transfer = await w().evaluateHandle((list) => {
    window.__droppedPaths = Object.fromEntries(list.map((p, index) => [`drop-${index}`, p]));
    if (!Object.getOwnPropertyDescriptor(File.prototype, "path")) {
      Object.defineProperty(File.prototype, "path", { configurable: true, get() { return window.__droppedPaths?.[this.name] || ""; } });
    }
    const data = new DataTransfer();
    list.forEach((_, index) => data.items.add(new File(["x"], `drop-${index}`)));
    return data;
  }, paths);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

test.beforeAll(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-shoot-")));
  work = {
    root,
    wedding: path.join(root, "Wedding"),
    selects: path.join(root, "Selects"),
    scraps: path.join(root, "Scraps"),
    loose: path.join(root, "loose.jpg"),
  };
  fs.mkdirSync(path.join(work.wedding, "day2"), { recursive: true });
  fs.mkdirSync(work.selects);
  fs.mkdirSync(work.scraps);
  await writeUniqueJpeg(path.join(work.wedding, "a.jpg"));
  await writeUniqueJpeg(path.join(work.wedding, "b.jpg"));
  await writeUniqueJpeg(path.join(work.wedding, "day2", "c.jpg"));
  await writeUniqueJpeg(path.join(work.selects, "d.jpg"));
  await writeUniqueJpeg(path.join(work.scraps, "x.jpg"));
  await writeUniqueJpeg(path.join(work.scraps, "y.jpg"));
  await writeUniqueJpeg(work.loose);

  ctx = await launchApp({ testName: "folder-lifecycle" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (work) fs.rmSync(work.root, { recursive: true, force: true });
});

test("a folder dragged from Finder onto the folders is imported and becomes a folder of that name", async () => {
  test.setTimeout(120_000);
  const before = await libraryCount();
  await dropFromFinder([work.wedding], section());

  // The folder is there at once, and opens; its photos arrive as the import lands them.
  await expect(row("Wedding")).toBeVisible({ timeout: 15_000 });
  await expect(row("Wedding")).toHaveClass(/bg-selected/);
  await expect.poll(() => namesIn("Wedding"), { timeout: 90_000 }).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  await expect(cards()).toHaveCount(3, { timeout: 30_000 });
  expect(await cardNames()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  // An import like any other: the photos are in the library too.
  await expect.poll(libraryCount, { timeout: 30_000 }).toBe(before + 3);
  expect(await rowNames()).toEqual(["0:Wedding"]);
});

test("dropping the same folder again makes neither a second folder nor a second copy", async () => {
  test.setTimeout(120_000);
  const before = await libraryCount();
  await dropFromFinder([work.wedding], section());
  // The import runs and finds everything there already.
  await expect(w().getByText("3 already in catalog").first()).toBeVisible({ timeout: 60_000 });
  expect(await rowNames()).toEqual(["0:Wedding"]);
  expect(await namesIn("Wedding")).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  expect(await libraryCount()).toBe(before);
});

test("on a folder row, a folder from Finder lands inside it and loose files go into it", async () => {
  test.setTimeout(120_000);
  await dropFromFinder([work.selects, work.loose], row("Wedding"));
  await expect(row("Selects")).toBeVisible({ timeout: 15_000 });
  expect(await rowNames()).toEqual(["0:Wedding", "1:Selects"]);
  await expect.poll(() => namesIn("Selects"), { timeout: 90_000 }).toEqual(["d.jpg"]);
  await expect.poll(() => namesIn("Wedding"), { timeout: 30_000 }).toEqual(["a.jpg", "b.jpg", "c.jpg", "loose.jpg"]);
  const tree = await folders();
  expect(tree.Selects.parent_collection_id).toBe(tree.Wedding.collection_id);
});

test("deleting a folder asks what becomes of its photos; Cancel changes nothing", async () => {
  const before = await libraryCount();
  await row("Wedding").click({ button: "right" });
  await w().locator("[data-menu-item='delete']").click();
  await expect(w().getByText("Delete “Wedding”?")).toBeVisible();
  await expect(w().getByText("It holds 5 photos.")).toBeVisible();
  await expect(w().getByText("Its 1 subfolder goes with it.")).toBeVisible();
  await expect(w().locator("[data-choice='folder']")).toHaveText("Delete Folder Only");
  await expect(w().locator("[data-choice='library']")).toHaveText("Also Remove 5 Photos from Library");
  await expect(w().locator("[data-choice='trash']")).toHaveText("Also Move 5 Files to Trash");
  await w().getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await rowNames()).toEqual(["0:Wedding", "1:Selects"]);
  expect(await libraryCount()).toBe(before);
});

test("…out of the library: only the photos no other folder holds, and the files stay on disk", async () => {
  // a.jpg is in a portfolio too.
  await newFolder("Portfolio");
  await w().evaluate(async (file) => {
    const bridge = window.mediaWorkspace;
    const folder = (await bridge.listCollections()).find((c) => c.name === "Portfolio");
    const detail = await bridge.getAssetDetail(file);
    await bridge.collectionAddItems(folder.collection_id, [detail.asset_id]);
  }, path.join(work.wedding, "a.jpg"));
  const before = await libraryCount();

  await row("Wedding").click({ button: "right" });
  await w().locator("[data-menu-item='delete']").click();
  await expect(w().getByText("1 of them is in another folder too and stays in the library.")).toBeVisible();
  await w().locator("[data-choice='library']", { hasText: "Also Remove 4 Photos from Library" }).click();

  await expect.poll(rowNames, { timeout: 15_000 }).toEqual(["0:Portfolio"]);
  await expect(w().getByText("Folder deleted, 4 photos removed from the library")).toBeVisible();
  await expect.poll(libraryCount, { timeout: 15_000 }).toBe(before - 4);
  expect(await inLibrary(path.join(work.wedding, "a.jpg"))).toBe(true);
  expect(await inLibrary(path.join(work.wedding, "b.jpg"))).toBe(false);
  expect(await namesIn("Portfolio")).toEqual(["a.jpg"]);
  // Only the records went.
  for (const file of [path.join(work.wedding, "b.jpg"), path.join(work.wedding, "day2", "c.jpg"), path.join(work.selects, "d.jpg"), work.loose]) {
    expect(fs.existsSync(file), file).toBe(true);
  }
});

test("…or into the Trash: the files go with the records", async () => {
  test.setTimeout(120_000);
  await dropFromFinder([work.scraps], section());
  await expect.poll(() => namesIn("Scraps"), { timeout: 90_000 }).toEqual(["x.jpg", "y.jpg"]);
  const before = await libraryCount();

  await row("Scraps").click({ button: "right" });
  await w().locator("[data-menu-item='delete']").click();
  await w().locator("[data-choice='trash']", { hasText: "Also Move 2 Files to Trash" }).click();

  await expect.poll(rowNames, { timeout: 15_000 }).toEqual(["0:Portfolio"]);
  await expect.poll(() => fs.existsSync(path.join(work.scraps, "x.jpg")) || fs.existsSync(path.join(work.scraps, "y.jpg")), { timeout: 15_000 }).toBe(false);
  await expect.poll(libraryCount, { timeout: 15_000 }).toBe(before - 2);
});

test("…or nowhere: the folder alone goes, and an empty one goes without a question", async () => {
  const before = await libraryCount();
  await row("Portfolio").click({ button: "right" });
  await w().locator("[data-menu-item='delete']").click();
  await expect(w().getByText("It holds 1 photo.")).toBeVisible();
  await w().locator("[data-choice='folder']").click();
  await expect.poll(rowNames, { timeout: 15_000 }).toEqual([]);
  expect(await libraryCount()).toBe(before);
  expect(await inLibrary(path.join(work.wedding, "a.jpg"))).toBe(true);

  await newFolder("Empty");
  await row("Empty").click({ button: "right" });
  await w().locator("[data-menu-item='delete']").click();
  await expect.poll(rowNames, { timeout: 15_000 }).toEqual([]);
  await expect(w().locator("[data-choice]")).toHaveCount(0);
});
