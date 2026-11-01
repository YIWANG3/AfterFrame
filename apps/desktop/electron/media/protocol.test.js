const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTranscoder, pruneTranscodeCache, TRANSCODE_JPEG_QUALITY } = require("./protocol");

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-transcode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "IMG_0001.HEIC");
  fs.writeFileSync(source, "heic bytes");
  const calls = [];
  const convert = async (src, out, opts) => {
    calls.push({ src, out, ...opts });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(out, "jpeg bytes");
  };
  const cacheDir = path.join(dir, "cache");
  return { dir, source, calls, cacheDir, transcode: createTranscoder({ cacheDir, convert, ...options }) };
}

test("an original converts once, at JPEG 95; the cached render serves later requests", async (t) => {
  const { source, calls, cacheDir, transcode } = setup(t);
  const first = await transcode(source);
  assert.ok(first.endsWith(".jpg"));
  assert.equal(path.dirname(first), cacheDir);
  assert.equal(fs.readFileSync(first, "utf8"), "jpeg bytes");
  assert.equal(await transcode(source), first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].src, source);
  assert.equal(calls[0].quality, TRANSCODE_JPEG_QUALITY);
  assert.equal(TRANSCODE_JPEG_QUALITY, 95);
});

test("the render is written beside its name and renamed in, so nothing half-written is ever served", async (t) => {
  const { source, calls, cacheDir, transcode } = setup(t);
  const out = await transcode(source);
  assert.notEqual(calls[0].out, out);
  assert.equal(path.dirname(calls[0].out), cacheDir);
  assert.ok(path.basename(calls[0].out).startsWith("."));
  assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(out)]);
});

test("requests that arrive while it converts share the conversion", async (t) => {
  const { source, calls, transcode } = setup(t);
  const [a, b] = await Promise.all([transcode(source), transcode(source)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test("an edited original converts again", async (t) => {
  const { source, calls, transcode } = setup(t);
  const before = await transcode(source);
  fs.writeFileSync(source, "edited heic bytes");
  const after = await transcode(source);
  assert.notEqual(after, before);
  assert.equal(calls.length, 2);
});

test("a served render counts as used, so the budget keeps what the user keeps opening", async (t) => {
  const { source, transcode } = setup(t);
  const out = await transcode(source);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(out, old, old);
  await transcode(source);
  assert.ok(fs.statSync(out).mtimeMs > old.getTime() + 30_000);
});

test("the least recently used renders go once the cache is over its budget", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-transcode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ["a", "b", "c", "d"].map((name, i) => {
    const file = path.join(dir, `${name}.jpg`);
    fs.writeFileSync(file, "x".repeat(100));
    const when = new Date(Date.now() - (4 - i) * 60_000); // a oldest, d newest
    fs.utimesSync(file, when, when);
    return file;
  });
  fs.writeFileSync(path.join(dir, ".e.123.partial.jpg"), "y".repeat(1000)); // in progress: not the pruner's
  const gone = pruneTranscodeCache(dir, 250);
  assert.deepEqual(gone.sort(), [files[0], files[1]].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), [".e.123.partial.jpg", "c.jpg", "d.jpg"]);
  assert.deepEqual(pruneTranscodeCache(path.join(dir, "missing")), []);
});

test("a conversion prunes the cache to the budget it was given", async (t) => {
  const { dir, source, cacheDir, transcode } = setup(t, { budgetBytes: 15 });
  const other = path.join(dir, "IMG_0002.HEIC");
  fs.writeFileSync(other, "other heic bytes");
  const first = await transcode(source);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(first, old, old);
  const second = await transcode(other); // 10 + 10 bytes > 15: the older one goes
  assert.ok(fs.existsSync(second));
  assert.equal(fs.existsSync(first), false);
  assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(second)]);
});

test("a failed conversion serves nothing, leaves nothing behind, and the next request tries again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-transcode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "broken.heic");
  fs.writeFileSync(source, "not a heic");
  let attempts = 0;
  const cacheDir = path.join(dir, "cache");
  const transcode = createTranscoder({
    cacheDir,
    convert: async (_src, out) => { attempts += 1; fs.writeFileSync(out, "half"); throw new Error("cannot decode"); },
  });
  t.mock.method(console, "error", () => {});
  assert.equal(await transcode(source), null);
  assert.equal(await transcode(source), null);
  assert.equal(attempts, 2);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});
