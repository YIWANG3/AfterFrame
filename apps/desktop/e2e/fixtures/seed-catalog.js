// Seeds a small E2E catalog at apps/desktop/e2e/fixtures/test-catalog.afcatalog/
// with 10 generated images plus 3 real photographs (see make-real-images.js).
// Run once with:
//   node e2e/fixtures/seed-catalog.js
// Re-run anytime to regenerate from scratch (deletes existing fixture).
//
// The seeded catalog — DB (catalog.sqlite3) + previews — is committed to git so
// a fresh clone / CI runs the catalog-backed specs without re-seeding. The DB
// is force-tracked past the *.sqlite3 ignore via an exception in .gitignore;
// re-run this script and commit the result whenever the fixture set changes.

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const { OUT_DIR: REAL_IMAGES_DIR, SOURCES: REAL_IMAGES } = require("./make-real-images");

const FIXTURES_DIR = __dirname;
const CATALOG_DIR = path.join(FIXTURES_DIR, "test-catalog.afcatalog");
const IMAGES_DIR = path.join(FIXTURES_DIR, "test-images");
const REPO_ROOT = path.resolve(FIXTURES_DIR, "..", "..", "..", "..");
// Run the sidecar from SOURCE, not the packaged dist binary — the binary is
// only rebuilt at release time and silently goes stale in between.
const SIDECAR_SRC = path.join(REPO_ROOT, "services", "sidecar", "src");

const IMAGES = [
  { name: "001-red.jpg",    rgb: [180,  60,  60] },
  { name: "002-orange.jpg", rgb: [220, 140,  50] },
  { name: "003-yellow.jpg", rgb: [220, 200,  80] },
  { name: "004-green.jpg",  rgb: [ 80, 170,  90] },
  { name: "005-teal.jpg",   rgb: [ 60, 170, 180] },
  { name: "006-blue.jpg",   rgb: [ 70, 110, 200] },
  { name: "007-purple.jpg", rgb: [140,  80, 190] },
  { name: "008-pink.jpg",   rgb: [220, 110, 160] },
  { name: "009-gray.jpg",   rgb: [128, 128, 128] },
  { name: "010-black.jpg",  rgb: [ 24,  24,  24] },
];

async function generateImage(file, rgb) {
  const W = 600;
  const H = 400;
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      // Gentle diagonal gradient so each image is visually distinct
      const t = (x + y) / (W + H);
      buf[i]     = Math.max(0, Math.min(255, Math.round(rgb[0] * (0.5 + t * 0.7))));
      buf[i + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] * (0.5 + t * 0.7))));
      buf[i + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] * (0.5 + t * 0.7))));
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 80 })
    .toFile(file);
}

// video-tool is needed for video probe + poster during the import job below.
const VIDEO_TOOL_BIN = path.join(REPO_ROOT, "apps", "desktop", "native", "bin", "video-tool");
const VIDEOS_DIR = path.join(FIXTURES_DIR, "test-videos");

function runSidecar(args) {
  return execFileSync("python3", ["-m", "media_workspace", ...args], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: SIDECAR_SRC, VIDEO_TOOL_PATH: VIDEO_TOOL_BIN },
  });
}

async function main() {
  // Wipe + recreate dirs
  fs.rmSync(CATALOG_DIR, { recursive: true, force: true });
  fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  // 1. Generate 10 distinct test images
  console.log("Generating 10 fixture images…");
  for (const { name, rgb } of IMAGES) {
    await generateImage(path.join(IMAGES_DIR, name), rgb);
  }

  // 2. Initialize empty catalog (creates sqlite DB + dirs)
  console.log("Initializing catalog at", CATALOG_DIR);
  runSidecar(["--catalog", CATALOG_DIR, "init-catalog"]);

  // 3. Register the fixture images dir as an export root
  console.log("Registering export root:", IMAGES_DIR);
  runSidecar([
    "--catalog", CATALOG_DIR,
    "register-roots",
    "--root-type", "image",
    "--path", IMAGES_DIR,
  ]);

  // 4. Quick-register each image so the gallery has 10 entries
  for (const { name } of IMAGES) {
    const p = path.join(IMAGES_DIR, name);
    console.log("Registering", name);
    runSidecar([
      "--catalog", CATALOG_DIR,
      "quick-register",
      "--image-path", p,
    ]);
  }

  // 4b. Bring in the real-photo fixtures (committed under real-images/, NOT
  //     regenerated here — they're downscaled originals, see make-real-images.js).
  //     They register as a second export root so the gallery, preview pipeline,
  //     and metadata parsing get exercised against genuine photographs. Two of
  //     them carry an embedded 5-star XMP rating that import reads through, so
  //     the Rated filter ends up with 4 assets (see 02-navigation.spec.js).
  if (!fs.existsSync(REAL_IMAGES_DIR) ||
      REAL_IMAGES.some((n) => !fs.existsSync(path.join(REAL_IMAGES_DIR, n)))) {
    throw new Error(
      `Real-image fixtures missing under ${REAL_IMAGES_DIR}.\n` +
      `Run: node e2e/fixtures/make-real-images.js`,
    );
  }
  console.log("Registering export root:", REAL_IMAGES_DIR);
  runSidecar([
    "--catalog", CATALOG_DIR,
    "register-roots",
    "--root-type", "image",
    "--path", REAL_IMAGES_DIR,
  ]);
  for (const name of REAL_IMAGES) {
    console.log("Registering", name);
    runSidecar([
      "--catalog", CATALOG_DIR,
      "quick-register",
      "--image-path", path.join(REAL_IMAGES_DIR, name),
    ]);
  }

  // 4c. Import the committed sample video (test-videos/) through the real import
  //     job so it indexes as asset_type='video' (probe metadata + poster frame
  //     via video-tool). Exercises the video ingest + gallery/playback paths.
  if (!fs.existsSync(VIDEO_TOOL_BIN)) {
    throw new Error(`video-tool missing at ${VIDEO_TOOL_BIN}.\nRun: npm run build:native`);
  }
  console.log("Importing sample video from:", VIDEOS_DIR);
  runSidecar(["--catalog", CATALOG_DIR, "register-roots", "--root-type", "image", "--path", VIDEOS_DIR]);
  const videoJob = JSON.parse(runSidecar(["--catalog", CATALOG_DIR, "create-job", "--job-type", "import"]));
  runSidecar([
    "--catalog", CATALOG_DIR,
    "run-import-job",
    "--job-id", videoJob.job_id,
    "--mode", "processed_only",
    "--image-dir", VIDEOS_DIR,
  ]);

  // 5. Rate two images and tag one so the Rated filter and tag-search paths
  //    are exercisable in e2e (previously zero ratings made them no-ops).
  console.log("Rating 001/002 and tagging 003…");
  const browse = JSON.parse(runSidecar([
    "--catalog", CATALOG_DIR, "browse-images", "--status", "all", "--limit", "10", "--offset", "0",
  ]));
  const byStem = Object.fromEntries(browse.map((r) => [r.stem, r.asset_id]));
  runSidecar(["--catalog", CATALOG_DIR, "set-asset-rating", "--rating", "4",
    "--asset-id", byStem["001-red"], "--asset-id", byStem["002-orange"]]);
  runSidecar(["--catalog", CATALOG_DIR, "add-asset-tag",
    "--asset-id", byStem["003-yellow"], "--tag", "seeded-tag"]);

  // 5b. Deterministic gallery order: several specs click the FIRST tile under
  //     the default imported-desc sort and expect an image (press-E editor,
  //     lightbox zoom). The video imports last, and whether it lands in the
  //     same wall-clock second as the images (stem tiebreak → image first) or
  //     one second later (video first) was pure timing luck. Pin it behind them.
  execFileSync("python3", ["-c", `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(path.join(CATALOG_DIR, "catalog.sqlite3"))})
conn.execute("UPDATE assets SET created_at = datetime(created_at, '-60 seconds') WHERE asset_type = 'video'")
conn.commit()
conn.close()
`], { encoding: "utf-8", stdio: "inherit" });

  // 6. Give two assets GPS coordinates (Paris / Tokyo) so the map drawer has
  //    location points to cluster and the viewport filter has something to
  //    narrow down (see e2e/23-map.spec.js). Injected at the catalog level —
  //    generating real GPS EXIF would drag in another image-metadata dep.
  console.log("Injecting GPS for 001-red (Paris) and 002-orange (Tokyo)…");
  execFileSync("python3", ["-c", `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(SIDECAR_SRC)})
from media_workspace.db import connect, upsert_asset_location_from_metadata

conn = connect(Path(${JSON.stringify(CATALOG_DIR)}) / "catalog.sqlite3")
for asset_id, lat, lon in [
    (${JSON.stringify(byStem["001-red"])}, 48.8566, 2.3522),
    (${JSON.stringify(byStem["002-orange"])}, 35.6895, 139.6917),
]:
    row = conn.execute("SELECT metadata_json FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
    meta = json.loads(row["metadata_json"] or "{}")
    meta["gps_latitude"], meta["gps_longitude"] = lat, lon
    conn.execute("UPDATE assets SET metadata_json = ? WHERE asset_id = ?",
                 (json.dumps(meta, ensure_ascii=True, sort_keys=True), asset_id))
    upsert_asset_location_from_metadata(conn, asset_id, meta)
conn.commit()
conn.close()
print("GPS injected")
`], { encoding: "utf-8", env: { ...process.env }, stdio: "inherit" });

  console.log("\n✓ Seeded catalog:", CATALOG_DIR);
  console.log("✓ Images:", IMAGES_DIR);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { CATALOG_DIR, IMAGES_DIR };
