const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { createDialogs, register } = require("./dialogs");

// catalogDialogOptions starts in the nearest EXISTING folder, so the defaults
// must exist for the assertion to see them.
const DEFAULT_DIR = os.tmpdir();

function fakeDialog(result) {
  const calls = [];
  const dialog = {
    showOpenDialog: async (...args) => { calls.push(["open", ...args]); return result; },
    showSaveDialog: async (...args) => { calls.push(["save", ...args]); return result; },
  };
  return { dialog, calls };
}
const BrowserWindow = { fromWebContents: (sender) => ({ id: sender.id }) };
const event = { sender: { id: 7 } };

test("createDialogs: modal to the asking window on Windows / Linux, free-standing on macOS", async () => {
  const win = fakeDialog({ canceled: true });
  const windows = createDialogs({ dialog: win.dialog, BrowserWindow, platform: "win32" });
  await windows.showOpenDialogFor(event, { title: "x" });
  await windows.showSaveDialogFor(event, { title: "y" });
  assert.deepEqual(win.calls, [["open", { id: 7 }, { title: "x" }], ["save", { id: 7 }, { title: "y" }]]);
  assert.deepEqual(windows.dialogParent(event), { id: 7 });

  const mac = fakeDialog({ canceled: true });
  const macDialogs = createDialogs({ dialog: mac.dialog, BrowserWindow, platform: "darwin" });
  await macDialogs.showOpenDialogFor(event, { title: "x" });
  assert.deepEqual(mac.calls, [["open", { title: "x" }]]);
  assert.equal(macDialogs.dialogParent(event), null);
});

function registered(result, { platform = "darwin", settings = {} } = {}) {
  const { dialog, calls } = fakeDialog(result);
  const handlers = new Map();
  const allowed = [];
  const created = [];
  let stored = settings;
  register({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    dialogs: createDialogs({ dialog, BrowserWindow, platform }),
    platform,
    t: () => (key) => key,
    defaultCatalogDir: () => DEFAULT_DIR,
    createCatalogAt: (p) => { created.push(p); return `${p}.afcatalog`; },
    addAllowedMediaDir: (dir) => allowed.push(dir),
    readAppSettings: () => stored,
    updateAppSettings: async (mutate) => { stored = await mutate(stored); return stored; },
  });
  return { handlers, calls, allowed, created, settings: () => stored };
}

test("pick-directories: the import dialog's options for the platform, [] when cancelled", async () => {
  const picked = registered({ canceled: false, filePaths: ["/photos"] }, { platform: "win32" });
  assert.deepEqual(await picked.handlers.get("workspace:pick-directories")(event, "image", "folders"), ["/photos"]);
  assert.deepEqual(picked.calls[0][2].properties.includes("openDirectory"), true);
  const cancelled = registered({ canceled: true });
  assert.deepEqual(await cancelled.handlers.get("workspace:pick-directories")(event, "image", "files"), []);
});

test("pick-handwriting-ref: the file's folder is allowed through media://", async () => {
  const picked = registered({ canceled: false, filePaths: ["/refs/hand.png"] });
  assert.equal(await picked.handlers.get("workspace:pick-handwriting-ref")(event), "/refs/hand.png");
  assert.deepEqual(picked.allowed, ["/refs"]);
  assert.deepEqual(picked.calls[0][1].filters[0].extensions, ["png", "jpg", "jpeg", "webp"]);
  assert.equal(await registered({ canceled: true }).handlers.get("workspace:pick-handwriting-ref")(event), null);
});

test("pick-repaint-refs: several images at once, each folder allowed through media://, [] when cancelled", async () => {
  const picked = registered({ canceled: false, filePaths: ["/refs/a.jpg", "/refs/b.png", "/other/c.jpg"] });
  assert.deepEqual(await picked.handlers.get("workspace:pick-repaint-refs")(event), ["/refs/a.jpg", "/refs/b.png", "/other/c.jpg"]);
  assert.deepEqual(picked.allowed, ["/refs", "/other"]);
  assert.ok(picked.calls[0][1].properties.includes("multiSelections"));
  assert.deepEqual(await registered({ canceled: true }).handlers.get("workspace:pick-repaint-refs")(event), []);
});

test("the reference pickers open in the folder they were last used in, and remember the new one", async () => {
  // Nothing remembered yet: no defaultPath, the panel decides.
  const first = registered({ canceled: false, filePaths: [path.join(DEFAULT_DIR, "a.jpg"), path.join(DEFAULT_DIR, "b.jpg")] });
  await first.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(first.calls[0][1].defaultPath, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.settings().pickerDirs.repaintReference, DEFAULT_DIR);

  // Remembered and still there: the picker starts in it. A cancelled pick
  // changes nothing.
  const again = registered({ canceled: true }, { settings: { pickerDirs: { repaintReference: DEFAULT_DIR, handwritingReference: DEFAULT_DIR } } });
  await again.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(again.calls[0][1].defaultPath, DEFAULT_DIR);
  await again.handlers.get("workspace:pick-handwriting-ref")(event);
  assert.equal(again.calls[1][1].defaultPath, DEFAULT_DIR);
  assert.equal(again.settings().pickerDirs.repaintReference, DEFAULT_DIR);

  // A remembered folder that is gone is not offered (the panel would show an error).
  const gone = registered({ canceled: true }, { settings: { pickerDirs: { repaintReference: path.join(DEFAULT_DIR, "no-such-folder-af") } } });
  await gone.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(gone.calls[0][1].defaultPath, undefined);
});

test("pick-catalog / create-catalog: start in the given folder; create goes through the catalog's path rules", async () => {
  const opened = registered({ canceled: false, filePaths: ["/libs/a.afcatalog"] });
  assert.equal(await opened.handlers.get("workspace:pick-catalog")(event), "/libs/a.afcatalog");
  assert.equal(opened.calls[0][0], "open");
  assert.equal(opened.calls[0][1].defaultPath, path.resolve(DEFAULT_DIR));

  const created = registered({ canceled: false, filePath: "/libs/new" });
  assert.equal(await created.handlers.get("workspace:create-catalog")(event), "/libs/new.afcatalog");
  assert.equal(created.calls[0][0], "save");
  assert.equal(created.calls[0][1].defaultPath, path.join(path.resolve(DEFAULT_DIR), "untitled.afcatalog"));
  assert.deepEqual(created.created, ["/libs/new"]);
  assert.equal(await registered({ canceled: true }).handlers.get("workspace:create-catalog")(event), null);
});
