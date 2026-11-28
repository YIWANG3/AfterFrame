// Remove from Library sends the files AfterFrame made inside the catalog to
// the Trash, and leaves every other file where it is (review 2026-11-27).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDerivedFile, removeFromLibrary } = require("./derivedFiles");

function catalog(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-derived-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "main.afcatalog");
  fs.mkdirSync(path.join(catalogPath, "derived"), { recursive: true });
  const write = (...parts) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    return file;
  };
  return { root, catalogPath, write };
}

test("a file is the catalog's own only inside its derived folder", (t) => {
  const { root, catalogPath, write } = catalog(t);
  assert.equal(isDerivedFile(write("main.afcatalog", "derived", "a_edit_1.jpg"), catalogPath), true);
  assert.equal(isDerivedFile(path.join(catalogPath, "derived", "gone.jpg"), catalogPath), true, "by its path, even once gone");
  assert.equal(isDerivedFile(write("Photos", "a.jpg"), catalogPath), false);
  assert.equal(isDerivedFile(write("main.afcatalog", "previews", "a.jpg"), catalogPath), false);
  assert.equal(isDerivedFile(write("main.afcatalog-derived", "a.jpg"), catalogPath), false);
  assert.equal(isDerivedFile(path.join(catalogPath, "derived", "..", "catalog.sqlite3"), catalogPath), false);
  assert.equal(isDerivedFile(path.join(catalogPath, "derived"), catalogPath), false, "the folder itself");
  assert.equal(isDerivedFile(path.join(root, "x.jpg"), null), false);
  assert.equal(isDerivedFile(null, catalogPath), false);
});

test("removing trashes the removed photos' derived files and nothing else", async (t) => {
  const { catalogPath, write } = catalog(t);
  const made = write("main.afcatalog", "derived", "collage_1_p1.jpg");
  const original = write("Photos", "a.jpg");
  const gone = path.join(catalogPath, "derived", "gone_edit_2.jpg");
  const rows = [
    { asset_id: "m", image_path: made },
    { asset_id: "o", image_path: original },
    { asset_id: "g", image_path: gone },
  ];
  const asked = [];
  const trashed = [];
  const commands = { deleteImageAssets: async (ids) => { asked.push(ids); return rows; } };
  const result = await removeFromLibrary({
    commands, assetIds: ["m", "o", "g"], catalogPath,
    trashItem: async (file) => { trashed.push(file); fs.rmSync(file); },
  });
  assert.deepEqual(asked, [["m", "o", "g"]]);
  assert.equal(result, rows, "the sidecar's rows, as before");
  assert.deepEqual(trashed, [made]);
  assert.ok(fs.existsSync(original), "an imported original stays on disk");
});

test("a file the Trash refuses stays, and the removal still succeeds", async (t) => {
  const { catalogPath, write } = catalog(t);
  const made = write("main.afcatalog", "derived", "a_text_1.jpg");
  const rows = [{ asset_id: "m", image_path: made }];
  const result = await removeFromLibrary({
    commands: { deleteImageAssets: async () => rows },
    assetIds: ["m"], catalogPath,
    trashItem: async () => { throw new Error("no Trash on this volume"); },
  });
  assert.equal(result, rows);
  assert.ok(fs.existsSync(made));
});
