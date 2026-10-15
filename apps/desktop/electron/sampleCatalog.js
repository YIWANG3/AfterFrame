// The bundled demo library, and the self-repair every catalog gets when it
// is opened.
//
// Sample catalog: a first-run library for exploring the app. Created on the
// user's first click (never silently on install, so demo photos are never
// mistaken for the user's own data) and reopened directly afterwards. It
// lives under userData — app-owned, apart from real catalogs — and the
// bundled photos are copied INSIDE the catalog folder, so resetting is one
// folder delete and the media allowlist covers them without extra roots.
//
// prepareCatalogPath runs when a catalog is opened or switched to: the
// sidecar's startup migrations for catalogs written by older builds, and —
// for the sample — the cleanup of the bundled previews an older importer put
// into the catalog (repairLegacySamplePreviews). It lives here because the
// sample is the one case with moving parts of its own.

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
    await commands.failJob(job.job_id, "Stopped for sample preview cleanup");
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

// Wiring from main.js:
//   catalog          ./catalog.js state (path / hasDb / hasDbAt / samplePath / isSample)
//   source           the bundled sample-photos directory
//   transport        sidecar transport (withCatalogPaused)
//   commands         sidecar verb layer
//   startImportTask  tasks.js
//   switchCatalogTo  main.js — catalog switching stays there (see catalog.js)
//   registerRoots    main.js — allowlist + sidecar register-roots
function createSampleCatalog({ catalog, source, transport, commands, startImportTask, switchCatalogTo, registerRoots }) {
  async function prepareCatalogPath() {
    console.log("[prepareCatalogPath] catalog:", catalog.path());
    if (!catalog.path()) return;
    fs.mkdirSync(catalog.path(), { recursive: true });
    if (!catalog.hasDb()) {
      console.log("[prepareCatalogPath] empty catalog, skipping sidecar migration");
      return;
    }
    try { await commands.splitSharedAssets(); } catch (_) { /* best-effort */ }
    try { await commands.repairResourceSets(); } catch (_) { /* best-effort */ }
    if (catalog.isSample()) {
      const repaired = await repairLegacySamplePreviews({
        catalogPath: catalog.path(), source, transport, commands, getCatalogPath: catalog.path,
      });
      if (repaired) {
        const originals = sampleOriginalNames(source)
          .map((name) => path.join(catalog.samplePath(), "photos", name)).filter((file) => fs.existsSync(file));
        if (originals.length) {
          // Resume an interrupted sample import without resurrecting originals
          // the user deliberately removed from this catalog.
          await startImportTask({ mode: "processed_only", imageDirs: originals, auto: true });
        }
      }
    }
  }

  async function openSampleCatalog({ reset = false } = {}) {
    const samplePath = catalog.samplePath();
    if (reset && fs.existsSync(samplePath)) {
      await transport.withCatalogPaused(samplePath, () =>
        fs.promises.rm(samplePath, { recursive: true, force: true }));
    }
    // No DB yet means the catalog was never populated (or was reset / deleted
    // externally) — copy the bundled photos and import them. Both steps are
    // idempotent, so an interrupted first open self-heals on the next one.
    const fresh = !catalog.hasDbAt(samplePath);
    const photosDir = path.join(samplePath, "photos");
    let originals = [];
    if (fresh) {
      fs.mkdirSync(samplePath, { recursive: true });
      originals = copySampleOriginals(source, photosDir);
    }
    await switchCatalogTo(samplePath);
    if (fresh) {
      await registerRoots("image", [photosDir]);
      await startImportTask({ mode: "processed_only", imageDirs: originals });
    }
    return { path: samplePath, fresh };
  }

  return { prepareCatalogPath, openSampleCatalog };
}

module.exports = { sampleOriginalNames, copySampleOriginals, repairLegacySamplePreviews, createSampleCatalog };
