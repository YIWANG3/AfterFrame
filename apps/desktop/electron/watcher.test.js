const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { register, importTargets } = require("./watcher");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fdDir = process.platform === "darwin" ? "/dev/fd" : process.platform === "linux" ? "/proc/self/fd" : null;
const openFds = () => fs.readdirSync(fdDir).length;

function setup(t, { changedMedia } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-watch-"));
  const watched = path.join(root, "Trips");
  const catalogPath = path.join(watched, "My.afcatalog");
  fs.mkdirSync(path.join(watched, "day 1"), { recursive: true });
  fs.mkdirSync(path.join(catalogPath, "previews"), { recursive: true });
  const sent = [];
  const handlers = {};
  const api = register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    getMainWindow: () => ({ webContents: { isDestroyed: () => false, send: (_channel, paths) => sent.push(paths) } }),
    getCatalogPath: () => catalogPath,
    readCatalogSettings: () => ({ integrations: { watchedDirs: [watched] } }),
    updateCatalogSettings: async () => {},
    changedMedia,
    quietPeriodMs: 200,
  });
  t.after(() => {
    api.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { api, watched, catalogPath, sent };
}

test("watching a folder holds a handle per folder, not per file (#130)", { skip: !fdDir }, async (t) => {
  const { api, watched } = setup(t);
  for (let i = 0; i < 2000; i += 1) fs.writeFileSync(path.join(watched, "day 1", `IMG_${i}.CR3`), "");
  const before = openFds();
  api.start();
  await sleep(300);
  const grew = openFds() - before;
  assert.ok(grew < 20, `watching 2,000 files opened ${grew} descriptors`);
});

test("new media is imported once writes go quiet; hidden, catalog and non-media files aren't", async (t) => {
  const { api, watched, catalogPath, sent } = setup(t);
  api.start();
  await sleep(300); // FSEvents takes a moment to start reporting
  fs.writeFileSync(path.join(watched, "day 1", "DSC_0001.NEF"), "raw");
  fs.mkdirSync(path.join(watched, ".Trashes"));
  fs.writeFileSync(path.join(watched, ".Trashes", "DSC_0002.NEF"), "raw");
  fs.writeFileSync(path.join(watched, "._DSC_0003.NEF"), "appledouble");
  fs.writeFileSync(path.join(catalogPath, "previews", "raw_1.jpg"), "preview");
  fs.writeFileSync(path.join(watched, "notes.txt"), "text");
  const deadline = Date.now() + 5000;
  while (!sent.length && Date.now() < deadline) await sleep(100);
  await sleep(400);
  assert.deepEqual(sent.flat().map((p) => fs.realpathSync(p)), [fs.realpathSync(path.join(watched, "day 1", "DSC_0001.NEF"))]);
});

async function waitFor(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(100);
}

test("a photo AirDrop marked as sent isn't imported again", { skip: process.platform !== "darwin" }, async (t) => {
  const known = new Set();
  const checked = [];
  const { api, watched, sent } = setup(t, {
    changedMedia: async (paths) => {
      checked.push(...paths);
      return { changed: paths.filter((p) => !known.has(p)), unchanged: 0 };
    },
  });
  api.start();
  await sleep(300);
  const photo = path.join(watched, "day 1", "sent.jpg");
  fs.writeFileSync(photo, "jpeg");
  await waitFor(() => sent.length);
  assert.deepEqual(sent.flat(), [photo]);

  // Imported: the catalog now holds it as it is on disk.
  known.add(photo);
  sent.length = 0;
  checked.length = 0;
  execFileSync("xattr", ["-w", "com.apple.metadata:kMDItemUserSharedSentTransport", "com.apple.AirDrop", photo]);
  await waitFor(() => checked.length);
  await sleep(400);
  assert.deepEqual(checked, [photo]);
  assert.deepEqual(sent, []);
});

test("files are imported when the catalog can't say whether they changed", async (t) => {
  const { api, watched, sent } = setup(t, {
    changedMedia: async () => { throw new Error("sidecar busy"); },
  });
  api.start();
  await sleep(300);
  const photo = path.join(watched, "day 1", "DSC_0004.NEF");
  fs.writeFileSync(photo, "raw");
  await waitFor(() => sent.length);
  assert.deepEqual(sent.flat().map((p) => fs.realpathSync(p)), [fs.realpathSync(photo)]);
});

test("many files go to the importer as their outermost folders", () => {
  const files = [
    ...Array.from({ length: 400 }, (_, i) => path.join("/Trips", "Tokyo", `${i}.CR3`)),
    ...Array.from({ length: 400 }, (_, i) => path.join("/Trips", "Tokyo", "day 2", `${i}.CR3`)),
    path.join("/Trips", "Tokyo 2", "1.CR3"),
  ];
  assert.deepEqual(importTargets(files), [path.join("/Trips", "Tokyo"), path.join("/Trips", "Tokyo 2")]);
  assert.deepEqual(importTargets(files.slice(0, 3)), files.slice(0, 3));
});
