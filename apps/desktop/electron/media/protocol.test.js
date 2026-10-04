const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeicTranscoder } = require("./protocol");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-heic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "IMG_0001.HEIC");
  fs.writeFileSync(source, "heic bytes");
  const calls = [];
  const convert = async (src, out) => {
    calls.push(src);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(out, "jpeg bytes");
  };
  return { dir, source, calls, transcode: createHeicTranscoder({ cacheDir: path.join(dir, "cache"), convert }) };
}

test("a HEIC converts once; the cached JPEG serves later requests", async (t) => {
  const { source, calls, transcode } = setup(t);
  const first = await transcode(source);
  assert.ok(first.endsWith(".jpg"));
  assert.equal(fs.readFileSync(first, "utf8"), "jpeg bytes");
  assert.equal(await transcode(source), first);
  assert.deepEqual(calls, [source]);
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

test("a failed conversion serves nothing, and the next request tries again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-heic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "broken.heic");
  fs.writeFileSync(source, "not a heic");
  let attempts = 0;
  const transcode = createHeicTranscoder({
    cacheDir: path.join(dir, "cache"),
    convert: async () => { attempts += 1; throw new Error("cannot decode"); },
  });
  t.mock.method(console, "error", () => {});
  assert.equal(await transcode(source), null);
  assert.equal(await transcode(source), null);
  assert.equal(attempts, 2);
});
