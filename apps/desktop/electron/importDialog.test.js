const test = require("node:test");
const assert = require("node:assert/strict");
const { importDialogOptions, splitsImport } = require("./importDialog");
const { makeT } = require("./i18n");

const t = makeT("en");

test("macOS picks files and folders in one dialog", () => {
  assert.deepEqual(importDialogOptions({ platform: "darwin", kind: "image", t }), {
    title: "Import files or folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
  });
  assert.equal(importDialogOptions({ platform: "darwin", kind: "raw", t }).title, "Add raw source files or folders");
  assert.equal(splitsImport("darwin"), false);
});

test("Windows asks for files or folders, never both", () => {
  assert.equal(splitsImport("win32"), true);
  assert.deepEqual(importDialogOptions({ platform: "win32", kind: "image", pick: "files", t }), {
    title: "Import files",
    properties: ["openFile", "multiSelections"],
  });
  assert.deepEqual(importDialogOptions({ platform: "win32", kind: "image", pick: "folders", t }), {
    title: "Import folders",
    properties: ["openDirectory", "multiSelections"],
  });
  // Callers without a pick (Add Raw Sources, watched folders) get folders.
  assert.deepEqual(importDialogOptions({ platform: "win32", kind: "raw", t }).properties, ["openDirectory", "multiSelections"]);
  for (const pick of [undefined, "files", "folders"]) {
    const { properties } = importDialogOptions({ platform: "linux", kind: "image", pick, t });
    assert.ok(!(properties.includes("openFile") && properties.includes("openDirectory")), String(pick));
  }
});

test("a pick narrows the macOS dialog too", () => {
  assert.deepEqual(importDialogOptions({ platform: "darwin", kind: "image", pick: "folders", t }).properties, ["openDirectory", "multiSelections"]);
});

test("every title has a Chinese translation", () => {
  const zh = makeT("zh-CN");
  for (const key of ["importTitle", "importFilesTitle", "importFoldersTitle", "addRawTitle", "addRawFilesTitle", "addRawFoldersTitle"]) {
    assert.notEqual(zh(`dialog.${key}`), t(`dialog.${key}`), key);
    assert.notEqual(t(`dialog.${key}`), `dialog.${key}`, key);
  }
});
