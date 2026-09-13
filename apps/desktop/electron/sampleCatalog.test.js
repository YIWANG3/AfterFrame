const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { copySampleOriginals, repairLegacySamplePreviews } = require("./sampleCatalog");

const source = path.join(__dirname, "..", "sample-photos");

test("sample copy includes exactly the 14 manifest originals, not web thumbnails or metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-sample-copy-"));
  try {
    const originals = copySampleOriginals(source, root);
    assert.equal(originals.length, 14);
    assert.equal(fs.readdirSync(root).length, 14);
    for (const file of originals) {
      assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(source, path.basename(file))));
    }
    assert.equal(fs.existsSync(path.join(root, "previews")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy cleanup preserves unrelated files and can resume after a failed catalog update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-sample-repair-"));
  const previewDir = path.join(root, "photos", "previews");
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "sample-01.jpg"), "bundled thumbnail");
  fs.writeFileSync(path.join(previewDir, "my-photo.jpg"), "user photo");
  fs.writeFileSync(path.join(root, "photos", "sample-01.jpg"), "original with edits");
  let failDelete = true;
  const deleted = [];
  const options = {
    catalogPath: root, source, getCatalogPath: () => root,
    transport: { withCatalogPaused: async (_path, action) => action() },
    commands: {
      listActiveJobs: async () => [],
      assetDetail: async ({ imagePath }) => {
        assert.equal(path.dirname(imagePath), previewDir);
        if (path.basename(imagePath) === "sample-01.jpg") return { asset_id: "preview-id" };
        throw new Error(`unknown export asset: ${imagePath}`);
      },
      deleteImageAssets: async (ids) => {
        assert.deepEqual(ids, ["preview-id"]);
        if (failDelete) throw new Error("temporary database error");
        deleted.push(...ids);
      },
    },
  };
  try {
    await assert.rejects(repairLegacySamplePreviews(options), /temporary database error/);
    assert.equal(fs.existsSync(path.join(root, ".sample-originals-only-v1")), false);
    failDelete = false;
    assert.equal(await repairLegacySamplePreviews(options), true);
    assert.equal(await repairLegacySamplePreviews(options), false, "migration runs only once");
    assert.deepEqual(deleted, ["preview-id"]);
    assert.equal(fs.readFileSync(path.join(previewDir, "my-photo.jpg"), "utf8"), "user photo");
    assert.equal(fs.readFileSync(path.join(root, "photos", "sample-01.jpg"), "utf8"), "original with edits");
    assert.equal(fs.readFileSync(path.join(root, "legacy-sample-previews", "sample-01.jpg"), "utf8"), "bundled thumbnail");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
