const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { register } = require("./stickers");

const event = {};

function registered({ platform = "darwin", nativeBin = path.join(os.tmpdir(), "no-such-native-bin") } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "af-stickers-"));
  const handlers = new Map();
  const allowed = [];
  register({
    app: { getPath: (name) => (name === "temp" ? os.tmpdir() : userData) },
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
