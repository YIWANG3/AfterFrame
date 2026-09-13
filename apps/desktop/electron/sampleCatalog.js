const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// The manifest names originals only. The sibling previews/ directory belongs
// to the web demo and must never be part of the desktop import source.
function sampleOriginalNames(source) {
  return Object.keys(JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")))
    .filter((name) => /^sample-\d+\.jpg$/.test(name));
}

function copySampleOriginals(source, photosDir) {
  fs.mkdirSync(photosDir, { recursive: true });
  return sampleOriginalNames(source).map((name) => {
    const target = path.join(photosDir, name);
    fs.copyFileSync(path.join(source, name), target);
    return target;
  });
}

async function repairLegacySamplePreviews({ catalogPath, source, transport, commands, getCatalogPath }) {
  const names = sampleOriginalNames(source);
  const previewDir = path.join(catalogPath, "photos", "previews");
  const backupDir = path.join(catalogPath, "legacy-sample-previews");
  const marker = path.join(catalogPath, ".sample-originals-only-v1");
  const hasLegacyFiles = names.some((name) => fs.existsSync(path.join(previewDir, name)));
  if (!hasLegacyFiles && (fs.existsSync(marker) || !fs.existsSync(backupDir))) return false;

  const assertCatalog = () => {
    if (getCatalogPath() !== catalogPath) throw new Error("catalog switched during sample repair");
  };
  assertCatalog();
  const activeJobs = await commands.listActiveJobs();
  assertCatalog();
  await transport.withCatalogPaused(catalogPath, () => {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of names) {
      const oldPath = path.join(previewDir, name);
      if (!fs.existsSync(oldPath)) continue;
      const backupPath = path.join(backupDir, name);
      fs.renameSync(oldPath, fs.existsSync(backupPath) ? `${backupPath}.${randomUUID()}` : backupPath);
    }
  });
  // The old importer can have been halfway through. Its process is gone; mark
  // the interrupted job terminal so a clean originals-only import can restart.
  for (const job of activeJobs.filter((job) => ["queued", "running"].includes(job.status))) {
    assertCatalog();
    await transport.callJsonAsync(["fail-job", "--job-id", job.job_id, "--error", "Stopped for sample preview cleanup"]);
  }
  // Exact app-owned paths only: never delete by filename, dimensions, or
  // visual similarity in a user's normal library. Query AFTER draining writers.
  const ids = [];
  for (const name of names) {
    assertCatalog();
    try {
      const asset = await commands.assetDetail({ imagePath: path.join(previewDir, name) });
      if (asset?.asset_id) ids.push(asset.asset_id);
    } catch (err) {
      if (!String(err.message).includes("unknown export asset:")) throw err;
    }
  }
  assertCatalog();
  if (ids.length) await commands.deleteImageAssets(ids);
  assertCatalog();
  fs.writeFileSync(marker, "Bundled previews removed from the import source and catalog.\n");
  return true;
}

module.exports = { sampleOriginalNames, copySampleOriginals, repairLegacySamplePreviews };
