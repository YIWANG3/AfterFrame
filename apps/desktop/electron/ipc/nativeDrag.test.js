const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { register, pileAlpha, pileSafeDragIcon } = require("./nativeDrag");

test("pileAlpha: one file is opaque; N stacked copies composite back to ~0.92", () => {
  assert.equal(pileAlpha(1), 1);
  for (const n of [2, 10, 68]) {
    const a = pileAlpha(n);
    assert.ok(a > 0 && a < 1, `${n}: per-copy alpha in (0,1)`);
    assert.ok(Math.abs((1 - Math.pow(1 - a, n)) - 0.92) < 1e-9, `${n}: stack sums to 0.92`);
  }
});

test("pileSafeDragIcon: scales every premultiplied channel, keeps size, re-wraps at 2x", () => {
  const calls = [];
  const nativeImage = { createFromBitmap: (buf, opts) => { calls.push({ buf, opts }); return "wrapped"; } };
  const icon = { getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from([200, 100, 50, 255, 0, 0, 0, 0]) };
  assert.equal(pileSafeDragIcon(nativeImage, icon, 1), "wrapped");
  assert.deepEqual([...calls[0].buf], [200, 100, 50, 255, 0, 0, 0, 0], "a single file is untouched");
  pileSafeDragIcon(nativeImage, icon, 4);
  const a = pileAlpha(4);
  assert.deepEqual([...calls[1].buf], [200, 100, 50, 255, 0, 0, 0, 0].map((v) => Math.round(v * a)));
  assert.deepEqual(calls[1].opts, { width: 2, height: 1, scaleFactor: 2 });
  const empty = { getSize: () => ({ width: 0, height: 0 }) };
  assert.equal(pileSafeDragIcon(nativeImage, empty, 3), empty, "an empty image passes through");
});

// The handler with stand-ins for Electron and the addon; `file` is a real path.
function dragHandler({ platform = "darwin", addon, file }) {
  const calls = { start: [], startDrag: [], piled: 0 };
  const icon = {
    isEmpty: () => false, resize: () => icon, getSize: () => ({ width: 192, height: 128 }), toPNG: () => Buffer.from("png"),
    toBitmap: () => { calls.piled += 1; return Buffer.alloc(4); },
  };
  let handler;
  register({
    ipcMain: { handle: (_channel, fn) => { handler = fn; } },
    nativeImage: { createEmpty: () => ({ isEmpty: () => true }), createFromPath: () => icon, createFromBitmap: () => "piled" },
    BrowserWindow: { fromWebContents: () => ({ getNativeWindowHandle: () => Buffer.alloc(8) }) },
    nativeBin: "/nowhere", platform,
    loadAddon: () => { if (!addon) throw new Error("no addon"); return addon(calls); },
  });
  const sender = { startDrag: (options) => calls.startDrag.push(options) };
  return { calls, drag: (files = [file, file]) => handler({ sender }, { files }) };
}

test("macOS drags through the addon: every file, one unfaded icon at half its pixel size", (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-drag-")), "a.jpg");
  fs.writeFileSync(file, "x");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { calls, drag } = dragHandler({ file, addon: (c) => ({ start: (options) => c.start.push(options) }) });
  assert.deepEqual(drag(), { ok: true, count: 2 });
  assert.equal(calls.startDrag.length, 0);
  assert.equal(calls.piled, 0, "the icon isn't faded for a pile");
  const [{ handle, files, icon, width, height }] = calls.start;
  assert.deepEqual({ files, width, height, icon: icon.toString(), handle: handle.length }, { files: [file, file], width: 96, height: 64, icon: "png", handle: 8 });
  assert.deepEqual(drag([]), { ok: false, reason: "no-files" });
});

test("without the addon, off macOS, or when it throws, the drag is Electron's startDrag", (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-drag-")), "a.jpg");
  fs.writeFileSync(file, "x");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const broken = () => ({ start: () => { throw new Error("no window"); } });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  for (const options of [{ addon: null }, { platform: "win32", addon: broken }, { addon: broken }]) {
    const { calls, drag } = dragHandler({ file, ...options });
    assert.deepEqual(drag(), { ok: true, count: 2 });
    assert.deepEqual(calls.startDrag, [{ files: [file, file], icon: "piled" }]);
  }
});

// The built addon (npm run build:native), read back the ways a drop target
// reads a drag. The session itself needs a held mouse button.
test("the addon's pasteboard has every file once, and the URL list Chromium reads first", (t) => {
  const built = path.join(__dirname, "..", "..", "native", "bin", "file-drag.node");
  if (process.platform !== "darwin" || !fs.existsSync(built)) return t.skip("file-drag.node isn't built");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-drag-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ["a b.jpg", "照片.jpg", "c.dng"].map((name) => path.join(dir, name));
  for (const file of files) fs.writeFileSync(file, "x");
  const board = JSON.parse(require(built).pasteboard({ files }));
  assert.equal(board.items, 3);
  assert.deepEqual(board.files, files, "one file URL per item, as Finder reads them");
  assert.deepEqual(board.urlList.map((url) => require("node:url").fileURLToPath(url)), files);
  assert.deepEqual(board.titles, ["", "", ""]);
  assert.equal(board.sameByName, true, "the same entry under its WebURLsWithTitlesPboardType name");
  // The extra entry is on the first item only; the rest are what NSURL writes.
  assert.deepEqual(board.firstTypes.filter((type) => !board.secondTypes.includes(type)).length, 1);
});
