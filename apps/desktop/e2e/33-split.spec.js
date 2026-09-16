// Seamless split tool (docs/split-carousel-plan.md): defaults, count/aspect
// commits, the UI export into the <stem>_split subfolder, pixel-exact
// seamlessness against the source, and registration into the version stack.
// Drives the real tool rail / panel buttons; reads state through the
// __afterframeTest backdoor; asserts on the files with sharp.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");

const W = 2400;
const H = 800;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-split-"));
const fixturePath = path.join(tmp, "pano-fixture.jpg");
const outDir = path.join(tmp, "pano-fixture_split");
const splitState = (window) => window.evaluate(() => window.__afterframeTest.getSplitState());

async function writeFixture() {
  // Smooth gradient plus a fine texture so a misplaced seam would show up in
  // the pixel comparison rather than hide inside a flat colour.
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = Math.floor((x / W) * 255);
      buf[i + 1] = Math.floor((y / H) * 255);
      buf[i + 2] = (x * 7 + y * 3) % 256;
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toFile(fixturePath);
}

async function meanAbsDiff(a, b) {
  expect(a.length).toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

test.describe("Seamless split", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    await writeFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "split" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    // Register the fixture as a catalog asset so the panels can join its
    // version stack (the editor itself opens by path).
    await window.evaluate((p) => window.mediaWorkspace.quickRegister(p, null), fixturePath);
    await expect.poll(
      () => window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p).then((d) => d?.asset_id || null), fixturePath),
      { timeout: 10_000 },
    ).toBeTruthy();
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await waitForEditor(window, { preview: true });
    await window.getByTestId("tool-split").click();
    await expect.poll(async () => (await splitState(window)).rect, { timeout: 10_000 }).toBeTruthy();
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("defaults: 3:4 panels, automatic count, full-height region", async () => {
    const s = await splitState(window);
    expect(s.aspectKey).toBe("3:4");
    expect(s.isAutoCount).toBe(true);
    // floor(2400 / (800 × 0.75)) = 4 panels, which exactly covers the photo.
    expect(s.count).toBe(4);
    expect(s.rect.x).toBeCloseTo(0, 2);
    expect(s.rect.y).toBeCloseTo(0, 2);
    expect(s.rect.width).toBeCloseTo(1, 2);
    expect(s.rect.height).toBeCloseTo(1, 2);
    await expect(window.getByTestId("split-count")).toHaveText("4");
    await expect(window.getByTestId("split-panel-size")).toHaveText("600 × 800");
    await expect(window.getByTestId("split-overlay")).toBeVisible();
    await expect(window.getByTestId("split-output-dir")).toHaveAttribute("data-path", outDir);
    await expect(window.getByTestId("split-subfolder")).toBeChecked();
  });

  test("count stepper reshapes the region, keeps 3:4 panels, and is undoable", async () => {
    await window.getByRole("button", { name: "Fewer panels" }).click();
    await expect(window.getByTestId("split-count")).toHaveText("3");
    let s = await splitState(window);
    expect(s.isAutoCount).toBe(false);
    expect(s.rect.height).toBeCloseTo(1, 2);
    expect(s.rect.width).toBeCloseTo(0.75, 2);
    expect(s.rect.x).toBeCloseTo(0.125, 2);
    await expect(window.getByTestId("split-panel-size")).toHaveText("600 × 800");

    await window.evaluate(() => window.__afterframeTest.undo());
    await expect(window.getByTestId("split-count")).toHaveText("4");
    s = await splitState(window);
    expect(s.isAutoCount).toBe(true);
    await window.evaluate(() => window.__afterframeTest.redo());
    await expect(window.getByTestId("split-count")).toHaveText("3");
  });

  test("aspect preset changes the panel shape around the same centre", async () => {
    await window.getByRole("button", { name: "1:1" }).click();
    const s = await splitState(window);
    expect(s.aspectKey).toBe("1:1");
    expect(s.count).toBe(3);
    // 3 square panels at full height = 2400px wide = the whole photo.
    expect(s.rect.width).toBeCloseTo(1, 2);
    await expect(window.getByTestId("split-panel-size")).toHaveText("800 × 800");
    await window.getByRole("button", { name: "3:4" }).click();
    await expect(window.getByTestId("split-panel-size")).toHaveText("600 × 800");
  });

  test("custom W:H typed into the ratio inputs drives the panel shape", async () => {
    await window.getByTestId("split-custom-width").fill("2");
    expect((await splitState(window)).aspectKey).toBe("custom");
    await window.getByTestId("split-custom-height").fill("1");
    await window.getByTestId("split-custom-height").press("Enter");
    let s = await splitState(window);
    expect(s.aspectKey).toBe("custom");
    expect(s.custom).toEqual({ width: 2, height: 1 });
    // 3 panels of 2:1 at full height would be 4800px wide: the width wins, so
    // the region is the full 2400px and each panel is 800 × 400.
    await expect(window.getByTestId("split-panel-size")).toHaveText("800 × 400");
    await window.getByRole("button", { name: "3:4" }).click();
    s = await splitState(window);
    expect(s.aspectKey).toBe("3:4");
    expect(s.custom).toEqual({ width: 2, height: 1 }); // remembered for next time
    await expect(window.getByTestId("split-panel-size")).toHaveText("600 × 800");
  });

  test("Export writes N seamless panels into <stem>_split and registers them as versions", async () => {
    expect(fs.existsSync(outDir)).toBe(false);
    await window.getByTestId("split-export").click();
    const files = [1, 2, 3].map((i) => path.join(outDir, `pano-fixture_split_0${i}.jpg`));
    await expect.poll(() => files.every((file) => fs.existsSync(file)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await splitState(window)).exporting, { timeout: 30_000 }).toBe(false);
    expect(fs.readdirSync(outDir)).toHaveLength(3);

    // Region = centre 1800px at full height → three 600×800 panels.
    let totalWidth = 0;
    for (const file of files) {
      const m = await sharp(file).metadata();
      expect(m.height).toBe(H);
      expect(m.width / m.height).toBeCloseTo(3 / 4, 2);
      totalWidth += m.width;
    }
    expect(totalWidth).toBe(1800);

    // Seamless: each panel equals the matching slice of the source (JPEG noise
    // only), so concatenating them reproduces the region with no gap/overlap.
    let left = 300;
    for (const file of files) {
      const m = await sharp(file).metadata();
      const panel = await sharp(file).raw().toBuffer();
      const source = await sharp(fixturePath).extract({ left, top: 0, width: m.width, height: H }).raw().toBuffer();
      expect(await meanAbsDiff(panel, source)).toBeLessThan(6);
      left += m.width;
    }

    // Every panel joined the original's version stack.
    const origin = await window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), fixturePath);
    expect(origin?.resource_set_id).toBeTruthy();
    for (const file of files) {
      await expect.poll(
        () => window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p).then((d) => d?.resource_set_id || null), file),
        { timeout: 10_000 },
      ).toBe(origin.resource_set_id);
    }
    const originAfter = await window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), fixturePath);
    expect((originAfter.version_siblings || []).length).toBeGreaterThanOrEqual(3);
  });

  test("without the subfolder option the panels land directly in the target folder", async () => {
    const flatDir = path.join(tmp, "flat");
    fs.mkdirSync(flatDir);
    await window.getByTestId("split-subfolder").uncheck();
    await expect(window.getByTestId("split-output-dir")).toHaveAttribute("data-path", tmp);
    const results = await window.evaluate((dir) => window.__afterframeTest.exportSplit(dir), flatDir);
    expect(results.map((r) => path.basename(r.path)).sort()).toEqual([
      "pano-fixture_split_01.jpg", "pano-fixture_split_02.jpg", "pano-fixture_split_03.jpg",
    ]);
    expect(fs.readdirSync(flatDir).sort()).toEqual([
      "pano-fixture_split_01.jpg", "pano-fixture_split_02.jpg", "pano-fixture_split_03.jpg",
    ]);
    await window.getByTestId("split-subfolder").check();
    await expect(window.getByTestId("split-output-dir")).toHaveAttribute("data-path", outDir);
  });

  test("a straightened photo still splits seamlessly", async () => {
    // Free angle set in the crop tool; the split region rotates about its own
    // centre and the export cuts the region once before slicing.
    await window.evaluate(() => window.__afterframeTest.setTool("crop"));
    await window.evaluate(() => window.__afterframeTest.setAspect("free"));
    await window.getByTestId("tool-split").click();
    await expect.poll(async () => (await splitState(window)).rect, { timeout: 10_000 }).toBeTruthy();
    const angleDir = path.join(tmp, "angled");
    const before = await splitState(window);
    const results = await window.evaluate((dir) => window.__afterframeTest.exportSplit(dir), angleDir);
    expect(results).toHaveLength(before.count);
    const widths = [];
    for (const r of results) {
      const m = await sharp(r.path).metadata();
      widths.push(m.width);
      expect(m.height).toBe(results[0].height);
    }
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});
