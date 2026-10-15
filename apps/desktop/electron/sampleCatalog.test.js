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

// createSampleCatalog: the first open copies the bundled originals, switches,
// registers the photos root and imports; a later open only switches; reset
// removes the folder with the sidecar paused. prepareCatalogPath runs the
// sidecar migrations only for a catalog that has a database.
function fakeWiring(dir, { hasDb }) {
  const calls = [];
  const samplePath = path.join(dir, "sample.afcatalog");
  const catalog = {
    path: () => samplePath,
    hasDb: () => hasDb(),
    hasDbAt: (p) => p === samplePath && hasDb(),
    samplePath: () => samplePath,
    isSample: () => false,
  };
  const { createSampleCatalog } = require("./sampleCatalog");
  const sample = createSampleCatalog({
    catalog, source,
    transport: { withCatalogPaused: async (p, action) => { calls.push(["paused", p]); return action(); } },
    commands: {
      splitSharedAssets: async () => calls.push(["splitSharedAssets"]),
      repairResourceSets: async () => { calls.push(["repairResourceSets"]); throw new Error("best effort"); },
    },
    startImportTask: async (options) => calls.push(["import", options.mode, options.imageDirs.length]),
    switchCatalogTo: async (p) => calls.push(["switch", p]),
    registerRoots: async (type, roots) => calls.push(["roots", type, roots]),
  });
  return { sample, samplePath, calls };
}

test("openSampleCatalog: fresh copy + import on the first open, a plain switch afterwards, folder removal on reset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-sample-open-"));
  try {
    let populated = false;
    const { sample, samplePath, calls } = fakeWiring(dir, { hasDb: () => populated });
    assert.deepEqual(await sample.openSampleCatalog(), { path: samplePath, fresh: true });
    assert.equal(fs.readdirSync(path.join(samplePath, "photos")).length, 14);
    assert.deepEqual(calls, [
      ["switch", samplePath],
      ["roots", "image", [path.join(samplePath, "photos")]],
      ["import", "processed_only", 14],
    ]);
    populated = true;
    calls.length = 0;
    assert.deepEqual(await sample.openSampleCatalog(), { path: samplePath, fresh: false });
    assert.deepEqual(calls, [["switch", samplePath]]);
    calls.length = 0;
    populated = false;
    assert.deepEqual(await sample.openSampleCatalog({ reset: true }), { path: samplePath, fresh: true });
    assert.equal(calls[0][0], "paused");
    assert.deepEqual(calls.slice(1).map((c) => c[0]), ["switch", "roots", "import"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareCatalogPath: creates the folder, and runs the (best-effort) sidecar migrations only with a database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-sample-prepare-"));
  try {
    let populated = false;
    const { sample, samplePath, calls } = fakeWiring(dir, { hasDb: () => populated });
    await sample.prepareCatalogPath();
    assert.ok(fs.existsSync(samplePath));
    assert.deepEqual(calls, []);
    populated = true;
    await sample.prepareCatalogPath();
    assert.deepEqual(calls, [["splitSharedAssets"], ["repairResourceSets"]], "a failing migration does not stop the open");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
