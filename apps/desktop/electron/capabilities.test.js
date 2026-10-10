const test = require("node:test");
const assert = require("node:assert/strict");

const { desktopCapabilities } = require("./capabilities");

const MACOS14_HELPERS = new Set(["video-tool", "people-worker", "compute-depth", "extract-sticker"]);
const MACOS12_HELPERS = new Set(["video-tool"]);

test("a macOS 14 build declares nothing, so every feature stays available as before", () => {
  assert.deepEqual(desktopCapabilities("darwin", { hasHelper: (name) => MACOS14_HELPERS.has(name) }), {});
  assert.deepEqual(desktopCapabilities("darwin"), {});
});

test("a macOS 12 build locks the features whose helpers it leaves out", () => {
  const caps = desktopCapabilities("darwin", { hasHelper: (name) => MACOS12_HELPERS.has(name) });
  assert.deepEqual(caps, { depth: false, stickerExtract: false, people: false });
  for (const flag of ["video", "lut", "colors", "annotation", "aiRepaint", "fileSystem", "integrations"]) {
    assert.equal(caps[flag], undefined, `${flag} works on the macOS 12 builds`);
  }
});

test("each locked feature follows its own helper", () => {
  assert.deepEqual(desktopCapabilities("darwin", { hasHelper: (name) => name !== "extract-sticker" }), { stickerExtract: false });
});

test("Windows locks only the features with no engine there", () => {
  assert.deepEqual(desktopCapabilities("win32"), { depth: false, stickerExtract: false, people: false, lut: false });
  for (const flag of ["video", "colors", "annotation", "aiRepaint", "fileSystem", "integrations"]) {
    assert.equal(desktopCapabilities("win32")[flag], undefined, `${flag} works on Windows`);
  }
});
