// Prepares the real-photo E2E fixtures under fixtures/real-images/.
//
// Unlike the synthetic gradients in seed-catalog.js, these are real photographs
// — they carry genuine EXIF, real subjects (so VisionKit sticker detection and
// Depth-Anything have something to chew on), and real-world aspect ratios. That
// makes the catalog/editor/depth/sticker paths exercise the decode + metadata +
// preview chain on inputs that look like what users actually import.
//
// The originals are multi-hundred-megapixel exports (70MP+, ~100MB total) and
// must NOT be committed. This script downscales them to a git-friendly long edge
// while PRESERVING metadata, and writes the results into real-images/ which is
// committed. Run once (or after swapping source photos):
//   node e2e/fixtures/make-real-images.js
//
// Source photos live outside the repo; point SRC_DIR at wherever they are.
// On this machine they came from ~/Desktop/Export — override with
//   REAL_IMAGES_SRC=/path/to/originals node e2e/fixtures/make-real-images.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");

const FIXTURES_DIR = __dirname;
const OUT_DIR = path.join(FIXTURES_DIR, "real-images");
const SRC_DIR = process.env.REAL_IMAGES_SRC || path.join(os.homedir(), "Desktop", "Export");

// Long edge for the committed copy. 2400px keeps real detail (subjects, depth
// gradients) while landing each file around 1–2 MB at q82.
const LONG_EDGE = 2400;
const QUALITY = 82;

// Filenames are preserved so tests can refer to them by name. These are the
// three the user picked as representative real inputs.
const SOURCES = [
  "B0016108.jpg",
  "IMG_0695-Enhanced-NR-3.jpg",
  "0Y1A6707-9.jpg",
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const name of SOURCES) {
    const src = path.join(SRC_DIR, name);
    if (!fs.existsSync(src)) {
      throw new Error(
        `Source photo missing: ${src}\n` +
        `Set REAL_IMAGES_SRC to the directory holding the originals.`,
      );
    }
    const out = path.join(OUT_DIR, name);
    // withMetadata() keeps the original EXIF (camera, lens, orientation) so the
    // metadata-parsing paths see real data rather than a stripped header.
    await sharp(src)
      .rotate() // bake in EXIF orientation before resize so dimensions are upright
      .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .withMetadata()
      .jpeg({ quality: QUALITY })
      .toFile(out);
    const { size } = fs.statSync(out);
    const meta = await sharp(out).metadata();
    console.log(`✓ ${name} → ${meta.width}×${meta.height}, ${(size / 1024).toFixed(0)} KB`);
  }
  console.log("\n✓ Real-image fixtures written to", OUT_DIR);
}

// Absolute paths to the committed real-photo fixtures, for use by specs.
const REAL_IMAGE_PATHS = SOURCES.map((name) => path.join(OUT_DIR, name));

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { OUT_DIR, SOURCES, REAL_IMAGE_PATHS };
