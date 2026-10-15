// A cached depth map answers with ITS size, read from the PNG header — not
// the bundled model's 518×392 (review 2026-10-14 bug 4).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { pngSize, register } = require("./depth");

const png = (file, width, height) => sharp({ create: { width, height, channels: 3, background: "#000" } }).png().toFile(file);

test("pngSize reads width and height from the IHDR chunk, null for anything else", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-depth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await png(path.join(dir, "d.png"), 7, 5);
  assert.deepEqual(pngSize(path.join(dir, "d.png")), { width: 7, height: 5 });
  await sharp({ create: { width: 7, height: 5, channels: 3, background: "#000" } }).jpeg().toFile(path.join(dir, "d.jpg"));
  assert.equal(pngSize(path.join(dir, "d.jpg")), null);
  fs.writeFileSync(path.join(dir, "short.png"), Buffer.from([0x89, 0x50]));
  assert.equal(pngSize(path.join(dir, "short.png")), null);
  assert.equal(pngSize(path.join(dir, "missing.png")), null);
});

test("a cache hit reports the cached map's own size; checkOnly without a map is null", { skip: process.platform !== "darwin" && "compute-depth is macOS-only" }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "af-depth-userdata-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map();
  const { depthCachePath, resolveDepthModelPath } = register({
    app: { getPath: () => userData, getVersion: () => "0.0.0" },
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    dialog: {},
    isPackaged: false,
    readAppSettings: () => ({}),
    updateAppSettings: async () => {},
  });
  const source = path.join(userData, "photo.png");
  await png(source, 3, 3);
  const compute = handlers.get("workspace:compute-depth");
  assert.equal(await compute({}, { sourcePath: source, checkOnly: true }), null, "nothing cached: no inference on a check");
  // A map of a size the bundled model does not produce, where the handler looks for it.
  const mapPath = depthCachePath(source, resolveDepthModelPath());
  await png(mapPath, 640, 480);
  assert.deepEqual(await compute({}, { sourcePath: source }), { outputPath: mapPath, cached: true, width: 640, height: 480 });
  assert.deepEqual(await compute({}, { sourcePath: source, checkOnly: true }), { outputPath: mapPath, cached: true, width: 640, height: 480 });
});
