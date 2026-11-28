const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { register, sweepStaleScratch } = require("./stickers");

// Every folder these tests make goes when the file is done (review
// 2026-11-27: each run left its folders in the temp dir).
const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const event = {};

// `temp` is the app's temp dir, where detections put their scratch folders.
function registered({ platform = "darwin", nativeBin = path.join(os.tmpdir(), "no-such-native-bin"), temp = tempDir("af-stickers-temp-") } = {}) {
  const userData = tempDir("af-stickers-");
  const handlers = new Map();
  const allowed = [];
  register({
    app: { getPath: (name) => (name === "temp" ? temp : userData) },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    nativeBin,
    platform,
    media: { addAllowedMediaDir: (dir) => allowed.push(dir) },
  });
  return { handlers, allowed, userData, call: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

// A real PNG, so sharp can read it back for the thumbnail.
function png(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
}

test("the feature answers exactly the channels its manifest declares", async () => {
  const { default: manifest } = await import("../manifest.mjs");
  const { handlers } = registered();
  assert.deepEqual([...handlers.keys()].sort(), manifest.contributes.ipc.map(([, channel]) => channel).sort());
});

test("save → list → star → delete round trip under <userData>/stickers/, with a thumbnail for each", async () => {
  const { call, userData } = registered();
  assert.deepEqual(await call("workspace:sticker-list"), []);

  const entry = await call("workspace:sticker-save", { bytes: await png(600, 300), name: "Cat", width: 600, height: 300, sourceLabel: "cat.jpg" });
  assert.equal(entry.name, "Cat");
  assert.equal(entry.starred, false);
  assert.ok(fs.existsSync(entry.path), "the PNG is in the library folder");
  assert.equal(path.dirname(entry.path), path.join(userData, "stickers"));
  assert.ok(fs.existsSync(entry.thumbPath), "a thumbnail sits next to it");
  const thumb = await sharp(entry.thumbPath).metadata();
  assert.equal(thumb.width, 512, "the thumbnail's long edge is 512");

  // Saving the same bytes again dedupes by content and moves the entry to the front.
  const other = await call("workspace:sticker-save", { bytes: await png(40, 40), name: "Dot" });
  await call("workspace:sticker-save", { bytes: await png(600, 300), name: "Cat again" });
  const list = await call("workspace:sticker-list");
  assert.deepEqual(list.map((s) => s.name), ["Cat again", "Dot"]);
  assert.equal(list.length, 2);

  assert.equal((await call("workspace:sticker-toggle-star", other.id)).starred, true);
  assert.equal((await call("workspace:sticker-list")).find((s) => s.id === other.id).starred, true);

  assert.equal(await call("workspace:sticker-delete", other.id), true);
  assert.equal(await call("workspace:sticker-delete", other.id), false);
  assert.ok(!fs.existsSync(other.path) && !fs.existsSync(other.thumbPath), "delete removes both files");
  assert.deepEqual((await call("workspace:sticker-list")).map((s) => s.name), ["Cat again"]);
});

test("list backfills a missing thumbnail from the full PNG", async () => {
  const { call } = registered();
  const entry = await call("workspace:sticker-save", { bytes: await png(50, 50) });
  fs.unlinkSync(entry.thumbPath);
  const [listed] = await call("workspace:sticker-list");
  assert.ok(fs.existsSync(listed.thumbPath));
});

test("detect refuses off macOS, a missing source, and a missing helper, before spawning anything", async () => {
  await assert.rejects(registered({ platform: "win32" }).call("workspace:sticker-detect", { sourcePath: __filename }), /requires macOS/);
  await assert.rejects(registered().call("workspace:sticker-detect", { sourcePath: "/no/such.jpg" }), /Source not found/);
  await assert.rejects(registered().call("workspace:sticker-detect", { sourcePath: __filename }), /Sticker tool missing/);
});

test("cleanup-scratch removes only folders the feature made", async () => {
  const { call } = registered();
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-sticker-"));
  const theirs = fs.mkdtempSync(path.join(os.tmpdir(), "af-other-"));
  assert.equal(await call("workspace:sticker-cleanup-scratch", mine), true);
  assert.ok(!fs.existsSync(mine));
  assert.equal(await call("workspace:sticker-cleanup-scratch", theirs), false);
  assert.ok(fs.existsSync(theirs));
  assert.equal(await call("workspace:sticker-cleanup-scratch", null), false);
  fs.rmSync(theirs, { recursive: true, force: true });
});

// A sticker tool in a folder of its own: `script` is its shell body, or none
// for a tool that is only there (never run).
function nativeBinWith(script) {
  const dir = tempDir("af-stickers-bin-");
  const tool = path.join(dir, "extract-sticker");
  fs.writeFileSync(tool, `#!/bin/sh\n${script || "exit 0"}\n`);
  fs.chmodSync(tool, 0o755);
  return dir;
}

const scratchIn = (temp) => fs.readdirSync(temp).filter((name) => name.startsWith("afterframe-sticker-"));

test("a detection that fails removes its scratch folder: it never reaches the renderer to clean up", async () => {
  // Review 2026-11-27: a failure after the folder was made left it behind.
  const temp = tempDir("af-stickers-temp-");
  const source = path.join(temp, "photo.png");
  fs.writeFileSync(source, await png(100, 100));
  const { call } = registered({ nativeBin: nativeBinWith(), temp });
  await assert.rejects(
    call("workspace:sticker-detect", { sourcePath: source, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
    /Selection is too small/,
  );
  assert.deepEqual(scratchIn(temp), []);
});

test("a sticker tool that fails leaves no scratch folder either", { skip: process.platform === "win32" && "a shell-script tool" }, async () => {
  const temp = tempDir("af-stickers-temp-");
  const source = path.join(temp, "photo.png");
  fs.writeFileSync(source, await png(100, 100));
  const { call } = registered({ nativeBin: nativeBinWith("echo 'no subject found' >&2\nexit 3"), temp });
  await assert.rejects(call("workspace:sticker-detect", { sourcePath: source }), /no subject found/);
  assert.deepEqual(scratchIn(temp), []);
});

test("scratch folders a day old are swept; fresh ones and other folders stay", async () => {
  const temp = tempDir("af-stickers-temp-");
  const aged = (name) => {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "cropped.png"), "x");
    const at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, at, at);
    return dir;
  };
  const stale = aged("afterframe-sticker-aaaaaaaaaaaa");
  aged("af-other-bbbbbb");
  fs.mkdirSync(path.join(temp, "afterframe-sticker-cccccccccccc"));
  assert.deepEqual(await sweepStaleScratch(temp), [stale]);
  assert.deepEqual(fs.readdirSync(temp).sort(), ["af-other-bbbbbb", "afterframe-sticker-cccccccccccc"]);
  assert.deepEqual(await sweepStaleScratch(path.join(temp, "missing")), []);
});
