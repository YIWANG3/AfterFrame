// The camera-mockup frame: the photo played back on a camera's display
// (frame-mockups/). Picking the template gives the photo its own camera (by
// EXIF) or the generic one, black bars on the rest of the display; the camera,
// the fit, the way it is held and the reflection change in the panel; the
// export has the photo on the display. The fixture has a blue top half and an
// orange bottom half, so the photo, the bars and the camera around them can be
// told apart in the saved file.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor, openEditorOn } = require("./helpers/app");

const SRC_W = 1600, SRC_H = 1000;
const BLUE = [40, 90, 200], ORANGE = [210, 120, 30];
// Must live in e2e/fixtures/: the app's media:// allowlist covers it.
const FIX = path.join(__dirname, "fixtures", "frame-mockup-1600.jpg");
const FIX_TALL = path.join(__dirname, "fixtures", "frame-mockup-tall.jpg");
const FIX_PHONE = path.join(__dirname, "fixtures", "frame-mockup-phone.jpg");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-frame-mockup-"));
const SHOTS = path.join(__dirname, "..", "test-results", "frame-mockup");

async function makeFixture(file, w, h) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const c = y < h / 2 ? BLUE : ORANGE;
      raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2];
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toFile(file);
}

async function readPixels(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { info, at };
}
const near = (c, ref, tol = 40) => c.every((v, i) => Math.abs(v - ref[i]) <= tol);
const dark = (c) => Math.max(...c) < 40;

test.describe("Camera mockup frame", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    await makeFixture(FIX, SRC_W, SRC_H);
    await makeFixture(FIX_TALL, SRC_H, SRC_W);
    fs.mkdirSync(SHOTS, { recursive: true });
    ({ app, window, userDataDir } = await launchApp({ testName: "frame-mockup" }));
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), FIX);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await waitForEditor(window, { preview: true });
    await window.evaluate(() => window.__afterframeTest.setTool("frame"));
    await expect(window.locator("[data-frame-templates]")).toBeVisible();
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of [FIX, FIX_TALL, FIX_PHONE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  });

  const state = () => window.evaluate(() => window.__afterframeTest.getState());
  const saveTo = async (name) => {
    const p = path.join(tmp, name);
    await window.evaluate(async (x) => { await window.__afterframeTest.saveAs(x); }, p);
    expect(fs.existsSync(p)).toBe(true);
    return p;
  };
  const clearToasts = async () => {
    const toasts = window.getByTestId("toast-card");
    for (let n = await toasts.count(); n > 0; n = await toasts.count()) {
      await toasts.first().getByRole("button", { name: "Dismiss" }).click();
    }
  };
  // Where the photo is in the saved file, from where the preview has it.
  const photoInExport = (s, info) => {
    const o = s.outputRect, c = s.outputContentRect;
    const fx = (x) => ((x - o.x) / o.width) * info.width;
    const fy = (y) => ((y - o.y) / o.height) * info.height;
    return { x0: fx(c.x), y0: fy(c.y), x1: fx(c.x + c.width), y1: fy(c.y + c.height) };
  };
  const mockupCanvas = (id) => window.locator(`[data-frame-mockup="${id}"][data-mockup-ready="true"]`);

  test("the template plays the photo back on the generic camera, filling its display, in the preview and the export", async () => {
    // Its thumbnail renders, camera included.
    await expect(window.locator('[data-frame-template="camera-screen"] img')).toBeVisible({ timeout: 15_000 });
    await window.locator('[data-frame-template="camera-screen"] button').first().click();
    // No camera in the photo's EXIF: the generic landscape one.
    await expect.poll(async () => (await state()).canvasMockup).toEqual({
      id: "hasselblad-907x", fit: "fill", rotation: "auto", layout: "screen", reflection: false, exposure: 0, radius: 0,
    });
    // No camera in the photo's EXIF: the panel says so.
    await expect(window.locator("[data-frame-mockup-missing]")).toHaveText("Camera not recognised");
    await expect(mockupCanvas("hasselblad-907x")).toBeVisible();
    await expect(window.locator("[data-frame-mockup-controls]")).toBeVisible();
    // The display has its own corners: no photo corner or shadow sliders.
    await expect(window.locator("[data-frame-photo-style]")).toHaveCount(0);
    await window.screenshot({ path: path.join(SHOTS, "generic.png") });

    const s = await state();
    // The camera is margin around the photo, on every side.
    const o = s.outputRect, c = s.outputContentRect;
    expect(c.x).toBeGreaterThan(o.x);
    expect(c.y).toBeGreaterThan(o.y);
    expect(c.x + c.width).toBeLessThan(o.x + o.width);
    expect(c.y + c.height).toBeLessThan(o.y + o.height);
    const out = await saveTo("generic.jpg");
    const { info, at } = await readPixels(out);
    const p = photoInExport(s, info);
    const cx = (p.x0 + p.x1) / 2, w = p.x1 - p.x0, h = p.y1 - p.y0;
    // A 16:10 photo filling a 4:3 display: photo to its top and bottom…
    expect(near(at(cx, p.y0 + h * 0.03), BLUE)).toBe(true);
    expect(near(at(cx, p.y1 - h * 0.03), ORANGE)).toBe(true);
    // …and its sides under the camera.
    expect(near(at(p.x0 + w * 0.02, p.y0 + h * 0.25), BLUE)).toBe(false);
    // Far out from the photo: the frame's light background.
    expect(Math.min(...at(4, 4))).toBeGreaterThan(220);
  });

  test("another camera, held upright, with a reflection", async () => {
    await clearToasts();
    await window.locator("[data-frame-mockup-camera]").selectOption("sony-a7-iv");
    await expect.poll(async () => (await state()).canvasMockup?.id).toBe("sony-a7-iv");
    await expect(mockupCanvas("sony-a7-iv")).toBeVisible();
    const level = (await state()).outputRect;
    expect(level.width).toBeGreaterThan(level.height);

    await window.locator("[data-frame-mockup-controls] button", { hasText: "Upright" }).click();
    await expect.poll(async () => (await state()).canvasMockup?.rotation).toBe(-90);
    const upright = (await state()).outputRect;
    expect(upright.height).toBeGreaterThan(upright.width);

    await window.locator("[data-frame-mockup-reflection] [role=switch]").click();
    await expect.poll(async () => (await state()).canvasMockup?.reflection).toBe(true);
    await window.screenshot({ path: path.join(SHOTS, "upright-reflection.png") });
  });

  test("the camera's exposure lightens the camera alone, in one undo step", async () => {
    await clearToasts();
    const mean = async (file) => {
      const { channels } = await sharp(file).stats();
      return (channels[0].mean + channels[1].mean + channels[2].mean) / 3;
    };
    const before = await state();
    const plain = await mean(await saveTo("exposure-0.jpg"));
    // A drag to +60, released.
    await window.getByTestId("frame-mockup-exposure").evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "60");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expect.poll(async () => (await state()).canvasMockup?.exposure).toBe(60);
    const after = await state();
    // Nothing moves: the same canvas, the same layers.
    expect(after.outputRect).toEqual(before.outputRect);
    expect(after.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
    expect(await mean(await saveTo("exposure-60.jpg"))).toBeGreaterThan(plain + 2);
    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await state()).canvasMockup?.exposure).toBe(0);
  });

  test("the display's corners round the photo on it, in one undo step, moving nothing", async () => {
    await clearToasts();
    const before = await state();
    await window.getByTestId("frame-mockup-radius").evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "60");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expect.poll(async () => (await state()).canvasMockup?.radius).toBe(60);
    expect((await state()).outputRect).toEqual(before.outputRect);
    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await state()).canvasMockup?.radius).toBe(0);
  });

  test("a canvas ratio widens the margins around the camera", async () => {
    await clearToasts();
    await window.locator("[data-frame-aspect]").getByRole("button", { name: "3:4" }).click();
    await expect.poll(async () => (await state()).canvasAspect).toBe("3:4");
    const out = await saveTo("ratio.jpg");
    const { info } = await readPixels(out);
    expect(info.width / info.height).toBeCloseTo(3 / 4, 2);
    // A big photo is drawn at the camera picture's resolution, not blown up around it.
    expect(Math.max(info.width, info.height)).toBeLessThan(4000);
  });

  test("the stack puts the camera above the photo, the photo on its display too", async () => {
    await clearToasts();
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen-stack"));
    await expect.poll(async () => (await state()).canvasMockup?.layout).toBe("stack");
    await expect(mockupCanvas("hasselblad-907x")).toBeVisible();
    // The photo is drawn as usual, with its corner and shadow sliders.
    await expect(window.locator("[data-frame-photo]")).toBeVisible();
    await expect(window.locator("[data-frame-photo-style]")).toHaveCount(1);
    const s = await state();
    const o = s.outputRect, c = s.outputContentRect;
    // The camera takes the upper part.
    expect(c.y - o.y).toBeGreaterThan(o.height * 0.3);
    const out = await saveTo("stack.jpg");
    const { info, at } = await readPixels(out);
    const p = photoInExport(s, info);
    const cx = (p.x0 + p.x1) / 2, h = p.y1 - p.y0;
    expect(near(at(cx, p.y0 + h * 0.25), BLUE)).toBe(true);
    expect(near(at(cx, p.y1 - h * 0.25), ORANGE)).toBe(true);
    await window.screenshot({ path: path.join(SHOTS, "stack.png") });
  });

  test("the templates without text: the camera alone, even margins", async () => {
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen-plain"));
    await expect.poll(async () => (await state()).canvasMockup?.layout).toBe("screen");
    let s = await state();
    expect(s.layers.filter((l) => l.fromPreset)).toEqual([]);
    expect(s.canvasPad.top).toBeCloseTo(s.canvasPad.bottom);
    expect(s.canvasPad.left).toBeCloseTo(s.canvasPad.bottom);
    // The photo's own shape (an earlier test set 3:4, which a template keeps).
    await window.locator("[data-frame-aspect]").getByRole("button", { name: "Photo" }).click();
    await expect.poll(async () => (await state()).canvasAspect).toBe(null);
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen-stack-plain"));
    await expect.poll(async () => (await state()).canvasMockup?.layout).toBe("stack");
    s = await state();
    expect(s.layers.filter((l) => l.fromPreset)).toEqual([]);
    // No border: the photo meets the canvas's sides and bottom, square-cornered.
    const o = s.outputRect, c = s.outputContentRect;
    expect(c.x).toBeCloseTo(o.x, 0);
    expect(c.x + c.width).toBeCloseTo(o.x + o.width, 0);
    expect(c.y + c.height).toBeCloseTo(o.y + o.height, 0);
    expect(s.canvasPhoto).toBe(null);
  });

  test("another template takes the camera away", async () => {
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
    await expect.poll(async () => (await state()).canvasMockup).toBe(null);
    await expect(window.locator("[data-frame-mockup]")).toHaveCount(0);
    await expect(window.locator("[data-frame-mockup-controls]")).toHaveCount(0);
  });

  test("a portrait photo gets the camera held upright", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), FIX_TALL);
    await waitForEditor(window, { preview: true });
    await window.evaluate(() => window.__afterframeTest.setTool("frame"));
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen"));
    await expect.poll(async () => (await state()).canvasMockup?.id).toBe("leica-m11-p");
    await expect(mockupCanvas("leica-m11-p")).toBeVisible();
    const s = await state();
    expect(s.canvasMockup.rotation).toBe("auto");
    expect(s.outputRect.height).toBeGreaterThan(s.outputRect.width);
    await expect(window.locator("[data-frame-mockup-controls] button", { hasText: "Upright" })).toHaveAttribute("aria-pressed", "true");
    await window.screenshot({ path: path.join(SHOTS, "portrait.png") });
  });

  test("a photo gets its own camera by EXIF, the signature under it", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    const row = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 100 })
      .then((rows) => rows.find((r) => r.stem === "0Y1A6707-9"))); // Canon R6 Mark II, 2400×1600
    await openEditorOn(window, row, "frame");
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen"));
    await expect.poll(async () => (await state()).canvasMockup?.id).toBe("canon-eos-r6-ii");
    await expect(mockupCanvas("canon-eos-r6-ii")).toBeVisible();
    const s = await state();
    const sig = s.layers.find((l) => l.fromPreset && l.text === "Canon EOS R6 Mark II");
    expect(sig).toBeTruthy();
    // Layers are in the photo's coordinates: the signature is below the photo,
    // under the camera's body.
    expect(sig.y).toBeGreaterThan(1.05);
    await window.screenshot({ path: path.join(SHOTS, "canon.png") });

    // Its own camera: no note in the panel.
    await expect(window.locator("[data-frame-mockup-missing]")).toHaveCount(0);

    // A camera chosen by hand lays the frame out again around it.
    await window.locator("[data-frame-mockup-camera]").selectOption("canon-eos-r1");
    await expect.poll(async () => (await state()).canvasMockup?.id).toBe("canon-eos-r1");
    const after = (await state()).layers.find((l) => l.fromPreset && l.text === "Canon EOS R6 Mark II");
    expect(after.y).not.toBeCloseTo(sig.y, 3);
    // Another maker's camera: the signature leaves the device's name out.
    await window.locator("[data-frame-mockup-camera]").selectOption("fujifilm-x100vi");
    await expect.poll(async () => (await state()).canvasMockup?.id).toBe("fujifilm-x100vi");
    const texts = (await state()).layers.filter((l) => l.fromPreset).map((l) => l.text);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => /Canon/.test(t))).toBe(false);
  });
  // Still on the Canon photo: its EXIF gives the template text.
  test("a ratio laid over a template keeps its text on the canvas", async () => {
    await clearToasts();
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("blur-story"));
    await expect.poll(async () => (await state()).canvasAspect).toBe("9:16");
    const presetIds = async () => (await state()).layers.filter((l) => l.fromPreset).map((l) => l.id);
    const before = await presetIds();
    expect(before.length).toBeGreaterThan(0);
    await window.locator("[data-frame-aspect]").getByRole("button", { name: "1:1" }).click();
    await expect.poll(async () => (await state()).canvasAspect).toBe("1:1");
    // Laid out again on the square canvas: every preset layer on it.
    await expect.poll(async () => (await presetIds()).join()).not.toBe(before.join());
    const s = await state();
    const ids = new Set(await presetIds());
    for (const l of s.displayLayers.filter((d) => ids.has(d.id))) {
      expect(l.y).toBeGreaterThan(0);
      expect(l.y).toBeLessThan(1);
    }
    await window.screenshot({ path: path.join(SHOTS, "ratio-relayout.png") });
  });

  // A phone's photo: no camera of its own here, so the generic one, a note
  // in the panel, and no "iPhone" under a Leica.
  test("a phone's photo gets the generic camera, a note, and no device name", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    await sharp({ create: { width: 1000, height: 1500, channels: 3, background: { r: BLUE[0], g: BLUE[1], b: BLUE[2] } } })
      .withExif({ IFD0: { Make: "Apple", Model: "iPhone XS Max" } }).jpeg({ quality: 92 }).toFile(FIX_PHONE);
    await window.evaluate((p) => window.mediaWorkspace.quickRegister(p, null), FIX_PHONE);
    await expect.poll(
      () => window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p).then((d) => d?.asset_id || null), FIX_PHONE),
      { timeout: 20_000 },
    ).toBeTruthy();
    const detail = await window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), FIX_PHONE);
    await openEditorOn(window, detail, "frame");
    await expect.poll(async () => {
      await window.evaluate(() => window.__afterframeTest.applyFramePreset("camera-screen"));
      return (await state()).canvasMockup?.id;
    }, { timeout: 30_000 }).toBe("leica-m11-p");
    await expect(window.locator("[data-frame-mockup-missing]")).toHaveText("No camera picture for iPhone XS Max");
    expect((await state()).layers.some((l) => /iPhone/.test(l.text || ""))).toBe(false);
  });
});
