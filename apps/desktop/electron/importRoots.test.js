const test = require("node:test");
const assert = require("node:assert/strict");
const { importableRoots } = require("./importRoots");

const statSync = (p) => {
  if (p.endsWith("/missing")) throw new Error("ENOENT");
  return { isDirectory: () => !p.includes(".") };
};

test("folders and importable files become roots; other files don't", () => {
  const roots = importableRoots(
    ["/photos/trip", "/photos/IMG_0001.JPG", "/photos/DSC_0002.NEF", "/photos/clip.mov", "/photos/notes.docx", "/photos/edits.xmp", "/photos/layered.psb"],
    { statSync },
  );
  assert.deepEqual(roots, ["/photos/trip", "/photos/IMG_0001.JPG", "/photos/DSC_0002.NEF", "/photos/clip.mov"]);
});

test("a folder whose name has a dot is still a folder", () => {
  assert.deepEqual(importableRoots(["/photos/2024.10"], { statSync: () => ({ isDirectory: () => true }) }), ["/photos/2024.10"]);
});

test("a path that can't be read is left to the sidecar", () => {
  assert.deepEqual(importableRoots(["/photos/missing"], { statSync }), ["/photos/missing"]);
});
