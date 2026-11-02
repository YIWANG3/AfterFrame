const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDialogs } = require("../../../electron/ipc/dialogs");
const { register } = require("./repaint");

const DEFAULT_DIR = os.tmpdir();
const BrowserWindow = { fromWebContents: (sender) => ({ id: sender.id }) };
const event = { sender: { id: 7 } };

function registered(pick, { settings = {}, userData = fs.mkdtempSync(path.join(os.tmpdir(), "af-repaint-")) } = {}) {
  const calls = [];
  const dialog = { showOpenDialog: async (...args) => { calls.push(args); return pick; } };
  const handlers = new Map();
  const allowed = [];
  const started = [];
  let stored = settings;
  register({
    app: { getPath: () => userData },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    commands: { listRepaintHistory: async (assetPath) => [{ for: assetPath }] },
    dialogs: createDialogs({
      dialog, BrowserWindow, platform: "darwin",
      readAppSettings: () => stored,
      updateAppSettings: async (mutate) => { stored = await mutate(stored); return stored; },
    }),
    catalog: { state: () => ({ currentCatalogPath: "/c.afcatalog" }) },
    media: { addAllowedMediaDir: (dir) => allowed.push(dir) },
    tasks: {
      startAiRepaintTask: async (options) => { started.push(options); return { jobId: "j1", status: "queued" }; },
      latestJobStatus: async () => null,
      formatJobStatus: (s) => s,
    },
  });
  return { handlers, calls, allowed, started, settings: () => stored, userData };
}

test("the feature answers exactly the channels its manifest declares", async () => {
  const { default: manifest } = await import("../manifest.mjs");
  const { handlers } = registered({ canceled: true });
  assert.deepEqual([...handlers.keys()].sort(), manifest.contributes.ipc.map(([, channel]) => channel).sort());
});

test("start forwards to the host's task starter; history asks the sidecar, [] without a path", async () => {
  const { handlers, started } = registered({ canceled: true });
  assert.deepEqual(await handlers.get("workspace:ai-repaint-start")(event, { sourcePath: "/p.jpg", prompt: "x" }), { jobId: "j1", status: "queued" });
  assert.deepEqual(started, [{ sourcePath: "/p.jpg", prompt: "x" }]);
  assert.deepEqual(await handlers.get("workspace:list-repaint-history")(event, "/p.jpg"), [{ for: "/p.jpg" }]);
  assert.deepEqual(await handlers.get("workspace:list-repaint-history")(event, ""), []);
});

test("styles: null until saved, then the saved JSON under userData/afterframe/", async () => {
  const { handlers, userData } = registered({ canceled: true });
  assert.equal(await handlers.get("workspace:get-ai-styles")(event), null);
  await handlers.get("workspace:save-ai-styles")(event, { styles: [{ name: "Film" }] });
  assert.deepEqual(await handlers.get("workspace:get-ai-styles")(event), { styles: [{ name: "Film" }] });
  assert.ok(fs.existsSync(path.join(userData, "afterframe", "ai-styles.json")));
});

test("pick-repaint-refs: several images at once, each folder allowed through media://, [] when cancelled", async () => {
  const picked = registered({ canceled: false, filePaths: ["/refs/a.jpg", "/refs/b.png", "/other/c.jpg"] });
  assert.deepEqual(await picked.handlers.get("workspace:pick-repaint-refs")(event), ["/refs/a.jpg", "/refs/b.png", "/other/c.jpg"]);
  assert.deepEqual(picked.allowed, ["/refs", "/other"]);
  assert.ok(picked.calls[0][0].properties.includes("multiSelections"));
  assert.deepEqual(await registered({ canceled: true }).handlers.get("workspace:pick-repaint-refs")(event), []);
});

test("the picker opens in the folder it was last used in, and remembers the new one", async () => {
  // Nothing remembered yet: no defaultPath, the panel decides.
  const first = registered({ canceled: false, filePaths: [path.join(DEFAULT_DIR, "a.jpg"), path.join(DEFAULT_DIR, "b.jpg")] });
  await first.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(first.calls[0][0].defaultPath, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.settings().pickerDirs.repaintReference, DEFAULT_DIR);

  // Remembered and still there: the picker starts in it. A cancelled pick changes nothing.
  const again = registered({ canceled: true }, { settings: { pickerDirs: { repaintReference: DEFAULT_DIR } } });
  await again.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(again.calls[0][0].defaultPath, DEFAULT_DIR);
  assert.equal(again.settings().pickerDirs.repaintReference, DEFAULT_DIR);

  // A remembered folder that is gone is not offered (the panel would show an error).
  const gone = registered({ canceled: true }, { settings: { pickerDirs: { repaintReference: path.join(DEFAULT_DIR, "no-such-folder-af") } } });
  await gone.handlers.get("workspace:pick-repaint-refs")(event);
  assert.equal(gone.calls[0][0].defaultPath, undefined);
});
