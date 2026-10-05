const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { catalogDialogOptions, nearestExistingDir } = require("./catalogDialog");
const { makeT } = require("./i18n");

const t = makeT("en");
const documents = path.resolve("/Users/me/Documents");
const afterframe = path.join(documents, "AfterFrame");
const existing = (...dirs) => (p) => dirs.some((d) => path.resolve(d) === p);

test("the default folder is used when it exists", () => {
  const exists = existing(documents, afterframe);
  assert.equal(nearestExistingDir(afterframe, exists), afterframe);
  assert.deepEqual(catalogDialogOptions({ action: "create", defaultDir: afterframe, t, exists }), {
    title: "New catalog",
    defaultPath: path.join(afterframe, "untitled.afcatalog"),
    buttonLabel: "Create Catalog",
  });
});

test("first run, no Documents\\AfterFrame yet: the dialog starts in Documents", () => {
  // Windows would otherwise open the app's working folder (System32).
  const exists = existing(path.dirname(documents), documents);
  assert.equal(
    catalogDialogOptions({ action: "create", defaultDir: afterframe, t, exists }).defaultPath,
    path.join(documents, "untitled.afcatalog"),
  );
  assert.deepEqual(catalogDialogOptions({ action: "open", defaultDir: documents, t, exists }), {
    title: "Open catalog",
    properties: ["openDirectory"],
    defaultPath: documents,
  });
});

test("a missing Documents falls back to the folder above it", () => {
  const home = path.dirname(documents);
  assert.equal(nearestExistingDir(afterframe, existing(home)), home);
});

test("nothing exists: no default folder rather than a made-up one", () => {
  assert.equal(nearestExistingDir(afterframe, () => false), undefined);
  assert.equal(catalogDialogOptions({ action: "open", defaultDir: documents, t, exists: () => false }).defaultPath, undefined);
});

test("every catalog dialog string has a Chinese translation", () => {
  const zh = makeT("zh-CN");
  for (const key of ["openCatalogTitle", "newCatalogTitle", "newCatalogButton"]) {
    assert.notEqual(t(`dialog.${key}`), `dialog.${key}`, key);
    assert.notEqual(zh(`dialog.${key}`), t(`dialog.${key}`), key);
  }
});
