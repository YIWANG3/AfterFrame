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

  test("clearing a frame preset removes the border and keeps ordinary layers", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const beforeCount = await window.evaluate(() => window.__afterframeTest.getLayerCount());
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom || 0), { timeout: 5_000 })
      .toBeGreaterThan(0.05);

    await window.evaluate(() => window.__afterframeTest.clearFramePreset());
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom || 0), { timeout: 5_000 })
      .toBe(0);
    expect(await window.evaluate(() => window.__afterframeTest.getLayerCount())).toBe(beforeCount);
    const cleared = await window.evaluate(() => window.__afterframeTest.getState());
    expect(cleared.outputRect.y + cleared.outputRect.height / 2).toBeCloseTo(cleared.placement.centerY, 1);
  });

  test("adding a bottom border keeps an existing text layer centered on the photo", async () => {
    await window.evaluate(() => window.__afterframeTest.clearFramePreset?.());
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const before = await window.evaluate(() => window.__afterframeTest.getState().layers[0]);
    expect(before.x).toBeCloseTo(0.5, 5);
    expect(before.y).toBeCloseTo(0.5, 5);

    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(0.3, 5);
    // STORED coords are full-photo and basis-independent → unchanged by the border.
    const after = await window.evaluate(() => window.__afterframeTest.getState().layers[0]);
    expect(after.x).toBeCloseTo(0.5, 5);
    expect(after.y).toBeCloseTo(0.5, 5);
    // The DERIVED (on-screen) position tracks the photo-content center: the photo
    // occupies the top 1 / 1.3 of the composed output, so display y = 0.5 / 1.3.
    const disp = await window.evaluate(() => window.__afterframeTest.getState().displayLayers[0]);
    expect(disp.x).toBeCloseTo(0.5, 3);
    expect(disp.y).toBeCloseTo(0.5 / 1.3, 3);
    await window.evaluate(() => window.__afterframeTest.setPad({}));
  });

  // Regression (the reason for the full-photo storage refactor): repeatedly
  // undo/redo-ing a margin change must not creep the text. With basis-independent
  // storage the stored y is invariant, and the derived display y is stable too.
  test("repeated undo/redo of a margin change does not drift the text layer", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const y0 = await window.evaluate(() => window.__afterframeTest.getState().layers[0].y);
    expect(y0).toBeCloseTo(0.5, 3);

    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5000 })
      .toBeCloseTo(0.3, 5);
    // Stored y is full-photo → unchanged; display y tracks the content center.
    expect(await window.evaluate(() => window.__afterframeTest.getState().layers[0].y)).toBeCloseTo(y0, 4);
    const dispY1 = await window.evaluate(() => window.__afterframeTest.getState().displayLayers[0].y);
    expect(dispY1).toBeCloseTo(0.5 / 1.3, 3);

    // Cycle several times — both stored and display y must be perfectly stable.
    for (let i = 0; i < 4; i++) {
      await window.evaluate(() => window.__afterframeTest.undo());
      await expect
        .poll(() => window.evaluate(() => window.__afterframeTest.getState().displayLayers[0].y), { timeout: 5000 })
        .toBeCloseTo(0.5, 4); // pad=0 → display == stored
      await window.evaluate(() => window.__afterframeTest.redo());
      await expect
        .poll(() => window.evaluate(() => window.__afterframeTest.getState().displayLayers[0].y), { timeout: 5000 })
        .toBeCloseTo(dispY1, 4);
    }
    // Stored y never moved through all the cycling.
    expect(await window.evaluate(() => window.__afterframeTest.getState().layers[0].y)).toBeCloseTo(y0, 4);
    await window.evaluate(() => window.__afterframeTest.setPad({})); // restore
  });

  test("wheel zoom still changes the framed text view after adding a border", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(0.3, 5);
    const before = await window.evaluate(() => window.__afterframeTest.getState().outputRect.width);
    const historyBefore = await window.evaluate(() => window.__afterframeTest.getState().historyLength);
    await window.locator("[data-editor-viewport='true']").dispatchEvent("wheel", {
      deltaY: -500,
      bubbles: true,
      cancelable: true,
    });
    await window.locator("[data-editor-viewport='true']").dispatchEvent("wheel", {
      deltaY: -500,
      bubbles: true,
      cancelable: true,
    });
    await window.locator("[data-editor-viewport='true']").dispatchEvent("wheel", {
      deltaY: -500,
      bubbles: true,
      cancelable: true,
    });
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().outputRect.width), { timeout: 5_000 })
      .not.toBeCloseTo(before, 3);
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().historyLength), { timeout: 5_000 })
      .toBe(historyBefore + 1);
    await window.evaluate(() => window.__afterframeTest.setPad({}));
  });

  // Recording the same state twice must not burn an undo step (idle blur /
  // repeated commit dedup in useEditorHistory.record).
  test("recording an identical state does not append a duplicate history entry", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const len0 = await window.evaluate(() => window.__afterframeTest.getState().historyLength);
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.25 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().historyLength), { timeout: 5_000 })
      .toBe(len0 + 1);
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.25 })); // identical
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => window.__afterframeTest.getState().historyLength)).toBe(len0 + 1);
    await window.evaluate(() => window.__afterframeTest.setPad({})); // restore
  });

  // Composed geometry: the border wraps the CROPPED photo — margins are based
  // on the crop's short edge and the crop is honored in the padded save.
  test("border wraps the cropped photo (crop + pad compose)", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    await window.evaluate(() => window.__afterframeTest.setAspect("1:1")); // 1600x1200 → centered 1200x1200 crop

    // Cropped baseline through the canvas path.
    const croppedPath = path.join(tmp, "cropped.jpg");
    await saveTo(croppedPath);
    const mc = await sharp(croppedPath).metadata();
    expect(Math.abs(mc.width - mc.height)).toBeLessThanOrEqual(3); // square crop
    expect(mc.width).toBeLessThan(SRC_W); // actually cropped

    // Same crop + a bottom margin: output = crop + 0.3 * (crop short edge).
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(0.3, 5);
    const paddedPath = path.join(tmp, "cropped-pad.jpg");
    await saveTo(paddedPath);
    const mp = await sharp(paddedPath).metadata();

    expect(mp.width).toBe(mc.width); // bottom-only pad: width = crop width
    const expectedH = mc.height + Math.round(0.3 * Math.min(mc.width, mc.height));
    expect(Math.abs(mp.height - expectedH)).toBeLessThanOrEqual(3);

    // The band under the photo is the white bg.
    const { data, info } = await sharp(paddedPath).raw().toBuffer({ resolveWithObject: true });
    const midX = Math.floor(info.width / 2);
    const rowY = info.height - 15;
    const idx = (rowY * info.width + midX) * info.channels;
    expect(data[idx]).toBeGreaterThan(230);
    expect(data[idx + 1]).toBeGreaterThan(230);
    expect(data[idx + 2]).toBeGreaterThan(230);

    await window.evaluate(() => window.__afterframeTest.setPad({})); // restore
  });

  test("large border auto-fits the framed view into the editor stage", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const before = await window.evaluate(() => window.__afterframeTest.getState());

    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 1 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(1, 5);

    const after = await window.evaluate(() => window.__afterframeTest.getState());
    expect(after.imageZoom).toBeCloseTo(before.imageZoom, 5);
    expect(after.viewTransform.scale).toBeLessThan(before.viewTransform.scale);
    expect(after.outputRect.width).toBeLessThanOrEqual(after.stageBounds.width * 0.94 + 1);
    expect(after.outputRect.height).toBeLessThanOrEqual(after.stageBounds.height * 0.94 + 1);
    expect(after.outputRect.x + after.outputRect.width / 2).toBeCloseTo(after.placement.centerX, 1);
    expect(after.outputRect.y + after.outputRect.height / 2).toBeCloseTo(after.placement.centerY, 1);

    await window.evaluate(() => window.__afterframeTest.setPad({}));
    const cleared = await window.evaluate(() => window.__afterframeTest.getState());
    expect(cleared.outputRect.y + cleared.outputRect.height / 2).toBeCloseTo(cleared.placement.centerY, 1);
  });

  test("dragging the photo content pans the image while a border is active", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    await window.evaluate(() => window.__afterframeTest.setAspect("1:1"));
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
    await window.evaluate(() => window.__afterframeTest.setPad({ bottom: 0.3 }));
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom), { timeout: 5_000 })
      .toBeCloseTo(0.3, 5);

    const beforeDrag = await window.evaluate(() => window.__afterframeTest.getState());
    const point = await window.locator("[data-editor-photo-pan-hotspot='true']").boundingBox().then((box) => ({
      x: box.x + 24,
      y: box.y + 24,
    }));
    await window.mouse.move(point.x, point.y);
    await window.mouse.down();
    await window.mouse.move(point.x + 80, point.y, { steps: 4 });
    await window.mouse.up();

    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getState().viewTransform.x), { timeout: 5_000 })
      .not.toBeCloseTo(beforeDrag.viewTransform.x, 3);
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    await expect
      .poll(() => window.evaluate(() => {
        const s = window.__afterframeTest.getState();
        return s.outputRect.x + s.outputRect.width / 2 - s.placement.centerX;
      }), { timeout: 5_000 })
      .toBeCloseTo(0, 1);
    const cleared = await window.evaluate(() => window.__afterframeTest.getState());
    expect(cleared.outputRect.x + cleared.outputRect.width / 2).toBeCloseTo(cleared.placement.centerX, 1);
    expect(cleared.outputRect.y + cleared.outputRect.height / 2).toBeCloseTo(cleared.placement.centerY, 1);
  });
});
