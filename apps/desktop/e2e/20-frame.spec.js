// Golden / characterization tests — the frame (watermark) tool export. Part of
// the EditorOverlay refactor safety net (Phase 0). Guards the two things most
// likely to regress: (1) export at ORIGINAL resolution (not the 2200px preview
// cap), (2) the frame expands the canvas (adds a band). Uses a >2200px fixture
// so the full-res vs preview distinction is observable.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");

const SRC_W = 3000, SRC_H = 2000; // deliberately > PREVIEW_MAX_EDGE (2200)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-golden-frame-"));
// Must live in e2e/fixtures/ — that dir is on the app's media:// allowlist, so
// the editor can load it (an arbitrary tmp path is blocked).
const BIG_FIXTURE = path.join(__dirname, "fixtures", "big-frame-3000.jpg");

async function makeBigFixture() {
  const p = BIG_FIXTURE;
  // simple horizontal gradient so it decodes as a normal photo
  const raw = Buffer.alloc(SRC_W * SRC_H * 3);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const i = (y * SRC_W + x) * 3;
      raw[i] = (x / SRC_W) * 255; raw[i + 1] = (y / SRC_H) * 255; raw[i + 2] = 140;
    }
  }
  await sharp(raw, { raw: { width: SRC_W, height: SRC_H, channels: 3 } }).jpeg().toFile(p);
  return p;
}

test.describe("Golden: frame export", () => {
  let app, window, userDataDir, fixturePath;

  test.beforeAll(async () => {
    fixturePath = await makeBigFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "golden-frame" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("frame"));
    // let the frame tool mount + build its base
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady()), { timeout: 10_000 })
      .toBe(true);
    await window.waitForTimeout(600);
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(BIG_FIXTURE, { force: true }); } catch { /* ignore */ }
  });

  test("export keeps ORIGINAL resolution (not the 2200px preview cap)", async () => {
    const outPath = path.join(tmp, "framed.jpg");
    const dims = await window.evaluate((p) => window.__afterframeTest.exportFrame(p), outPath);

    expect(fs.existsSync(outPath)).toBe(true);
    const m = await sharp(outPath).metadata();
    expect(m.format).toBe("jpeg");
    // width == source width (default bar preset adds no horizontal padding) →
    // proves the export ran on the full-res source, not the 2200px preview.
    expect(m.width).toBe(SRC_W);
    expect(m.width).toBeGreaterThan(2200);
    // the frame adds a bottom band → taller than the source.
    expect(m.height).toBeGreaterThan(SRC_H);
    // backdoor return matches the file
    expect(dims.width).toBe(m.width);
    expect(dims.height).toBe(m.height);
  });
});
