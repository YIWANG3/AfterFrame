const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { createDialogs, register } = require("./dialogs");

// catalogDialogOptions starts in the nearest EXISTING folder, so the defaults
// must exist for the assertion to see them.
const DEFAULT_DIR = os.tmpdir();

// result: what every open / save dialog returns, or a list of them in turn.
// boxResponses: the buttons clicked on message boxes, in turn.
function fakeDialog(result, boxResponses = []) {
  const calls = [];
  const results = Array.isArray(result) ? [...result] : null;
  const next = () => (results ? results.shift() : result);
  const dialog = {
    showOpenDialog: async (...args) => { calls.push(["open", ...args]); return next(); },
    showSaveDialog: async (...args) => { calls.push(["save", ...args]); return next(); },
    showMessageBox: async (...args) => { calls.push(["box", ...args]); return { response: boxResponses.shift() ?? 0 }; },
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

function registered(result, { platform = "darwin", settings = {}, networkPaths = [], boxResponses = [] } = {}) {
  const { dialog, calls } = fakeDialog(result, boxResponses);
  const handlers = new Map();
  const allowed = [];
  const created = [];
  let stored = settings;
  register({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    dialogs: createDialogs({
      dialog, BrowserWindow, platform,
      readAppSettings: () => stored,
      updateAppSettings: async (mutate) => { stored = await mutate(stored); return stored; },
    }),
    platform,
    t: () => (key) => key,
    defaultCatalogDir: () => DEFAULT_DIR,
    catalog: { createAt: (p) => { created.push(p); return `${p}.afcatalog`; } },
    media: { addAllowedMediaDir: (dir) => allowed.push(dir) },
    networkVolumeOf: async (p) => (networkPaths.includes(p) ? { fsType: "smbfs", mountPoint: "/Volumes/nas" } : null),
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

// The repaint feature's picker (features/repaint/electron/repaint.test.js)
// shares this memory through host.dialogs.
test("the handwriting picker opens in the folder it was last used in, and remembers the new one", async () => {
  // Nothing remembered yet: no defaultPath, the panel decides.
  const first = registered({ canceled: false, filePaths: [path.join(DEFAULT_DIR, "hand.png")] });
  await first.handlers.get("workspace:pick-handwriting-ref")(event);
  assert.equal(first.calls[0][1].defaultPath, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.settings().pickerDirs.handwritingReference, DEFAULT_DIR);

  // Remembered and still there: the picker starts in it. A cancelled pick
  // changes nothing.
  const again = registered({ canceled: true }, { settings: { pickerDirs: { handwritingReference: DEFAULT_DIR } } });
  await again.handlers.get("workspace:pick-handwriting-ref")(event);
  assert.equal(again.calls[0][1].defaultPath, DEFAULT_DIR);
  assert.equal(again.settings().pickerDirs.handwritingReference, DEFAULT_DIR);

  // A remembered folder that is gone is not offered (the panel would show an error).
  const gone = registered({ canceled: true }, { settings: { pickerDirs: { handwritingReference: path.join(DEFAULT_DIR, "no-such-folder-af") } } });
  await gone.handlers.get("workspace:pick-handwriting-ref")(event);
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

test("create-catalog on a network volume warns; Choose Another Location asks again, Create Here Anyway goes ahead", async () => {
  const nas = "/Volumes/nas/2026";
  const moved = registered(
    [{ canceled: false, filePath: nas }, { canceled: false, filePath: "/libs/local" }],
    { networkPaths: [nas], boxResponses: [0] },
  );
  assert.equal(await moved.handlers.get("workspace:create-catalog")(event), "/libs/local.afcatalog");
  assert.deepEqual(moved.calls.map((call) => call[0]), ["save", "box", "save"]);
  assert.equal(moved.calls[1][1].type, "warning");
  assert.deepEqual(moved.calls[1][1].buttons, ["dialog.networkCatalogChooseOther", "dialog.networkCatalogCreateAnyway"]);
  assert.deepEqual(moved.created, ["/libs/local"]);

  const anyway = registered({ canceled: false, filePath: nas }, { networkPaths: [nas], boxResponses: [1] });
  assert.equal(await anyway.handlers.get("workspace:create-catalog")(event), `${nas}.afcatalog`);
  assert.deepEqual(anyway.created, [nas]);
});

test("pick-catalog on a network volume warns; Cancel opens nothing, Open Anyway opens it", async () => {
  const nas = "/Volumes/nas/2026.afcatalog";
  const cancelled = registered({ canceled: false, filePaths: [nas] }, { networkPaths: [nas], boxResponses: [0] });
  assert.equal(await cancelled.handlers.get("workspace:pick-catalog")(event), null);
  assert.deepEqual(cancelled.calls[1][1].buttons, ["dialog.networkCatalogCancel", "dialog.networkCatalogOpenAnyway"]);

  const opened = registered({ canceled: false, filePaths: [nas] }, { networkPaths: [nas], boxResponses: [1] });
  assert.equal(await opened.handlers.get("workspace:pick-catalog")(event), nas);

  // A local catalog opens without a word.
  const local = registered({ canceled: false, filePaths: ["/libs/a.afcatalog"] });
  await local.handlers.get("workspace:pick-catalog")(event);
  assert.deepEqual(local.calls.map((call) => call[0]), ["open"]);
});
