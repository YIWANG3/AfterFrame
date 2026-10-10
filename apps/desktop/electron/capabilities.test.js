const test = require("node:test");
const assert = require("node:assert/strict");

const { desktopCapabilities } = require("./capabilities");

const SONOMA = "23.0.0";
const MONTEREY = "21.6.0";

test("the regular macOS build declares nothing, so every feature stays available as before", () => {
  assert.deepEqual(desktopCapabilities("darwin", { arch: "arm64", osRelease: SONOMA }), {});
  assert.deepEqual(desktopCapabilities("darwin", { arch: "arm64", osRelease: "25.0.0" }), {});
});

test("the Intel build locks what needs Apple silicon and macOS 14, on any macOS", () => {
  for (const osRelease of [MONTEREY, SONOMA, "25.0.0"]) {
    assert.deepEqual(desktopCapabilities("darwin", { arch: "x64", osRelease }), { depth: false, stickerExtract: false, people: false });
  }
  for (const flag of ["video", "lut", "colors", "annotation", "aiRepaint", "fileSystem", "integrations"]) {
    assert.equal(desktopCapabilities("darwin", { arch: "x64", osRelease: MONTEREY })[flag], undefined, `${flag} works on the Intel build`);
  }
});

test("Apple silicon below macOS 14 locks the same three", () => {
  assert.deepEqual(desktopCapabilities("darwin", { arch: "arm64", osRelease: MONTEREY }), { depth: false, stickerExtract: false, people: false });
});

test("Windows locks only the features with no engine there", () => {
  assert.deepEqual(desktopCapabilities("win32"), { depth: false, stickerExtract: false, people: false, lut: false });
  for (const flag of ["video", "colors", "annotation", "aiRepaint", "fileSystem", "integrations"]) {
    assert.equal(desktopCapabilities("win32")[flag], undefined, `${flag} works on Windows`);
  }
});
