// Seeds a small E2E catalog at apps/desktop/e2e/fixtures/test-catalog.afcatalog/
// with 10 generated images. Run once with:
//   node e2e/fixtures/seed-catalog.js
// Re-run anytime to regenerate from scratch (deletes existing fixture).
//
// The seeded catalog is committed to git so tests don't need to regenerate
// it on every run.

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const FIXTURES_DIR = __dirname;
const CATALOG_DIR = path.join(FIXTURES_DIR, "test-catalog.afcatalog");
const IMAGES_DIR = path.join(FIXTURES_DIR, "test-images");
const REPO_ROOT = path.resolve(FIXTURES_DIR, "..", "..", "..", "..");
const SIDECAR = path.join(REPO_ROOT, "services", "sidecar", "dist", "media-workspace", "media-workspace");

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
  return execFileSync(SIDECAR, args, { encoding: "utf-8" });
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
    "--root-type", "export",
    "--path", IMAGES_DIR,
  ]);

  // 4. Quick-register each image so the gallery has 10 entries
  for (const { name } of IMAGES) {
    const p = path.join(IMAGES_DIR, name);
    console.log("Registering", name);
    runSidecar([
      "--catalog", CATALOG_DIR,
      "quick-register",
      "--export-path", p,
    ]);
  }

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
