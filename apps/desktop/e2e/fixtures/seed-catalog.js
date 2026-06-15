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

function runSidecar(args) {
  return execFileSync("python3", ["-m", "media_workspace", ...args], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: SIDECAR_SRC },
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
