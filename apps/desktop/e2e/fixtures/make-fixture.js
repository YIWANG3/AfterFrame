// Generates a small JPG fixture for E2E tests. Run once with:
//   node e2e/fixtures/make-fixture.js
// or call ensureFixture() from a test setup.
//
// Why a real JPG: the editor reads dimensions + tries to decode the source,
// so we need actual valid image bytes. A 512x384 gradient is enough.

const path = require("node:path");
const fs = require("node:fs");
const sharp = require("sharp");

const OUT_PATH = path.resolve(__dirname, "test-image.jpg");

async function ensureFixture() {
  if (fs.existsSync(OUT_PATH)) return OUT_PATH;
  const W = 512;
  const H = 384;
  // Diagonal gradient — easy to eyeball if a test screenshot shows it.
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = Math.floor((x / W) * 255);      // R
      buf[i + 1] = Math.floor((y / H) * 255);  // G
      buf[i + 2] = 80;                          // B
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 85 })
    .toFile(OUT_PATH);
  return OUT_PATH;
}

if (require.main === module) {
  ensureFixture().then((p) => console.log("Wrote", p));
}

module.exports = { ensureFixture, OUT_PATH };
