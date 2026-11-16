// A folder dragged in from Finder that has subfolders asks how to file it:
// all of it in one folder (as before), or with its subfolders kept, each one
// on disk a folder of the same name inside it. Kept subfolders are made as
// their photos arrive, so one without photos makes none; dropping the same
// folder again finds the folders it made. A folder whose only subfolders are
// hidden doesn't ask, and Cancel imports nothing. (e2e/83 covers the drop
// itself and answers "one folder".)

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
const section = () => w().locator("[data-sidebar-folders='true']");
const row = (name) => w().getByTestId("sidebar-folder-scroll").locator("[data-collection-id]")
  .filter({ has: w().locator("span.truncate", { hasText: new RegExp(`^${name}$`) }) });
const cards = () => galleryCards(w());
const libraryCount = () => w().evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1000 }).then((rows) => rows.length));

// Every folder as "parent/child" → the names of the photos directly in it.
const tree = () => w().evaluate(async () => {
  const bridge = window.mediaWorkspace;
  const all = (await bridge.listCollections()).filter((c) => c.kind === "manual");
  const byId = Object.fromEntries(all.map((c) => [c.collection_id, c]));
  const pathOf = (c) => (c.parent_collection_id ? `${pathOf(byId[c.parent_collection_id])}/` : "") + c.name;
  const out = {};
  for (const folder of all) {
    const rows = await bridge.browseCollection(folder.collection_id, { limit: 200 });
    out[pathOf(folder)] = rows.map((r) => r.image_path.split(/[\\/]/).pop()).sort();
  }
  return out;
});

// A drag from Finder, as in e2e/83: the DOM events are dispatched, and the
// File made in the page answers `file.path` with the path meant.
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

const TRIP = {
  Trip: ["top.jpg"],
  "Trip/Day 1": ["a.jpg", "b.jpg"],
  "Trip/Day 2": ["c.jpg"],
  "Trip/Day 2/Sunset": ["d.jpg"],
};

test.beforeAll(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-structure-")));
  work = {
    root,
    trip: path.join(root, "Trip"),
    unsorted: path.join(root, "Unsorted"),
    flat: path.join(root, "Flat"),
  };
  for (const [folder, files] of Object.entries(TRIP)) {
    for (const file of files) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      await writeUniqueJpeg(path.join(root, folder, file));
    }
  }
  fs.mkdirSync(path.join(work.trip, "Notes")); // no photos: no folder
  fs.mkdirSync(path.join(work.unsorted, "inner"), { recursive: true });
  await writeUniqueJpeg(path.join(work.unsorted, "inner", "u.jpg"));
  fs.mkdirSync(path.join(work.flat, ".cache"), { recursive: true });
  await writeUniqueJpeg(path.join(work.flat, "f.jpg"));

  ctx = await launchApp({ testName: "folder-drop-structure" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (work) fs.rmSync(work.root, { recursive: true, force: true });
});

test("Cancel on the question imports nothing and makes no folder", async () => {
  const before = await libraryCount();
  await dropFromFinder([work.unsorted], section());
  await expect(w().getByText("“Unsorted” has subfolders")).toBeVisible();
  await w().locator("[data-choice='flat']").locator("..").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(w().locator("[data-choice]")).toHaveCount(0);
  expect(await tree()).toEqual({});
  expect(await libraryCount()).toBe(before);
});

test("kept subfolders: each folder on disk with photos becomes a folder inside", async () => {
  test.setTimeout(120_000);
  const before = await libraryCount();
  await dropFromFinder([work.trip], section());
  await w().locator("[data-choice='mirror']").click();

  // The dropped folder opens at once; the ones inside arrive with their photos.
  await expect(row("Trip")).toHaveClass(/bg-selected/, { timeout: 15_000 });
  await expect.poll(tree, { timeout: 90_000 }).toEqual(TRIP);
  await expect.poll(libraryCount, { timeout: 30_000 }).toBe(before + 5);
  // The dropped folder shows the whole shoot, its subfolders' photos too.
  await expect(cards()).toHaveCount(5, { timeout: 30_000 });
  const ids = Object.fromEntries((await callTool("manage_collections", { action: "list" })).collections.map((c) => [c.name, c]));
  expect(ids["Day 1"].parent_collection_id).toBe(ids.Trip.collection_id);
  expect(ids.Sunset.parent_collection_id).toBe(ids["Day 2"].collection_id);
});

test("dropping it again finds the folders it made", async () => {
  test.setTimeout(120_000);
  await dropFromFinder([work.trip], section());
  await w().locator("[data-choice='mirror']").click();
  await expect(w().getByText("5 already in catalog").first()).toBeVisible({ timeout: 60_000 });
  expect(await tree()).toEqual(TRIP);
});

test("a folder whose only subfolders are hidden doesn't ask", async () => {
  test.setTimeout(120_000);
  await dropFromFinder([work.flat], section());
  await expect(row("Flat")).toHaveClass(/bg-selected/, { timeout: 15_000 });
  await expect(w().locator("[data-choice]")).toHaveCount(0);
  await expect.poll(async () => (await tree()).Flat, { timeout: 90_000 }).toEqual(["f.jpg"]);
});
