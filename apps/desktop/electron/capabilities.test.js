const test = require("node:test");
const assert = require("node:assert/strict");

const { desktopCapabilities } = require("./capabilities");

test("macOS declares nothing, so every feature stays available as before", () => {
  assert.deepEqual(desktopCapabilities("darwin"), {});
});

test("Windows locks only the features with no engine there", () => {
  assert.deepEqual(desktopCapabilities("win32"), { depth: false, stickerExtract: false, people: false });
  for (const flag of ["video", "colors", "annotation", "aiRepaint", "fileSystem", "integrations"]) {
    assert.equal(desktopCapabilities("win32")[flag], undefined, `${flag} works on Windows`);
  }
});
