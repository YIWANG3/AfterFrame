// Unified-canvas Phase 2b — the SAVE path honors canvas.pad (margins around the
// photo). Guards the real output: a bottom margin makes the saved file taller
// by the margin, width unchanged, and the margin is filled with the bg color.
// Compares padded vs unpadded saves through the SAME canvas path (both carry a
// text layer) so resolution basis matches and only the margin differs.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");

const SRC_W = 1600, SRC_H = 1200; // small enough that sourceImage == full res
const FIX = path.join(__dirname, "fixtures", "canvas-pad-1600.jpg");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-canvas-pad-"));

async function makeFixture() {
  const raw = Buffer.alloc(SRC_W * SRC_H * 3);
  for (let y = 0; y < SRC_H; y++) for (let x = 0; x < SRC_W; x++) {
    const i = (y * SRC_W + x) * 3;
    raw[i] = (x / SRC_W) * 200; raw[i + 1] = 80; raw[i + 2] = (y / SRC_H) * 200;
  }
  await sharp(raw, { raw: { width: SRC_W, height: SRC_H, channels: 3 } }).jpeg().toFile(FIX);
  return FIX;
}

test.describe("Canvas margin (pad) save", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    await makeFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "canvas-pad" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), FIX);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady?.()), { timeout: 10_000 })
      .toBe(true);
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
    await window.evaluate(() => window.__afterframeTest.addTextLayer("pad"));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(FIX, { force: true }); } catch { /* ignore */ }
  });

  const saveTo = (p) => window.evaluate(async (x) => { await window.__afterframeTest.saveAs(x); }, p);

  test("bottom margin makes the output taller by the margin, width unchanged", async () => {
    // Baseline canvas save (text layer, pad=0).
    const base = path.join(tmp, "base.jpg");
    await saveTo(base);
    expect(fs.existsSync(base)).toBe(true);
    const m0 = await sharp(base).metadata();

    // Add a bottom margin (fraction of the short edge = 1200 → 360px). Poll
    // until the state actually reflects it, so the save doesn't race the update.
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(0.3, 5);
    const padded = path.join(tmp, "pad-bottom.jpg");
    await saveTo(padded);
    expect(fs.existsSync(padded)).toBe(true);
    const m1 = await sharp(padded).metadata();

    expect(m1.width).toBe(m0.width); // bottom-only pad: width unchanged
    expect(m1.height).toBeGreaterThan(m0.height + 100); // grew by ~0.3 * short edge

    // The bottom strip is the bg (default white) — sample a row inside the margin.
    const { data, info } = await sharp(padded).raw().toBuffer({ resolveWithObject: true });
    const midX = Math.floor(info.width / 2);
    const rowY = info.height - 20; // well inside the bottom margin
    const idx = (rowY * info.width + midX) * info.channels;
    expect(data[idx]).toBeGreaterThan(230);     // ~white bg
    expect(data[idx + 1]).toBeGreaterThan(230);
    expect(data[idx + 2]).toBeGreaterThan(230);

    await window.evaluate(() => window.__afterframeTest.setPad({})); // restore
  });

  // Phase 3: applying a frame preset sets the canvas margins from the template
  // and switches to the Text tool (text layers come from EXIF placeholders —
  // empty on this synthetic fixture, so the observable here is the margin).
  test("applyFramePreset sets canvas margins from the template + switches to text", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({})); // reset
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeGreaterThan(0.05); // bar-id has a bottom margin
    expect(await window.evaluate(() => window.__afterframeTest.getState().tool)).toBe("text");
    await window.evaluate(() => window.__afterframeTest.setPad({})); // restore
  });
});
