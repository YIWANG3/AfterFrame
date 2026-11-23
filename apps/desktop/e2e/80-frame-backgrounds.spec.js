// Frame backgrounds made from the photo (its colours, the photo blurred), the
// canvas ratio, the photo's corners and shadow, and round corners on a text
// background — chosen in the panels, shown in the preview, and in the saved
// file. The fixture has a blue top half, an orange bottom half and a white
// square in its top-left corner, so colours and rounded corners can be read
// back from the export. Recolouring a template's text needs a camera: the
// test catalog's Canon photo.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor, openEditorOn } = require("./helpers/app");

const SRC_W = 1600, SRC_H = 1000;
const BLUE = [40, 90, 200], ORANGE = [210, 120, 30];
// Must live in e2e/fixtures/: the app's media:// allowlist covers it.
const FIX = path.join(__dirname, "fixtures", "frame-backgrounds-1600.jpg");
// One blue all over: photo colours must still make a gradient of it.
const FIX_FLAT = path.join(__dirname, "fixtures", "frame-backgrounds-flat.jpg");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-frame-bg-"));
const SHOTS = path.join(__dirname, "..", "test-results", "frame-backgrounds");

async function makeFixture() {
  const raw = Buffer.alloc(SRC_W * SRC_H * 3);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const i = (y * SRC_W + x) * 3;
      const c = x < 200 && y < 200 ? [255, 255, 255] : y < SRC_H / 2 ? BLUE : ORANGE;
      raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2];
    }
  }
  await sharp(raw, { raw: { width: SRC_W, height: SRC_H, channels: 3 } }).jpeg({ quality: 95 }).toFile(FIX);
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: BLUE[0], g: BLUE[1], b: BLUE[2] } } })
    .jpeg({ quality: 95 }).toFile(FIX_FLAT);
}

async function readPixels(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { info, at };
}
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

test.describe("Frame backgrounds made from the photo", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    await makeFixture();
    fs.mkdirSync(SHOTS, { recursive: true });
    ({ app, window, userDataDir } = await launchApp({ testName: "frame-backgrounds" }));
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), FIX);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await waitForEditor(window, { preview: true });
    await window.evaluate(() => window.__afterframeTest.setTool("frame"));
    await expect(window.locator("[data-frame-photo-bg]")).toBeVisible();
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(FIX, { force: true }); fs.rmSync(FIX_FLAT, { force: true }); } catch { /* ignore */ }
  });

  const state = () => window.evaluate(() => window.__afterframeTest.getState());
  const saveTo = async (name) => {
    const p = path.join(tmp, name);
    await window.evaluate(async (x) => { await window.__afterframeTest.saveAs(x); }, p);
    expect(fs.existsSync(p)).toBe(true);
    return p;
  };
  // Each save leaves a toast in the bottom-right corner, over the panel's
  // lower controls (a click there waits ~20 s for them to time out): clear
  // them before reaching for one.
  const clearToasts = async () => {
    const toasts = window.getByTestId("toast-card");
    for (let n = await toasts.count(); n > 0; n = await toasts.count()) {
      await toasts.first().getByRole("button", { name: "Dismiss" }).click();
    }
  };

  test("photo colours: a margin appears, the top takes the photo's top colour, the bottom its bottom colour", async () => {
    await window.locator('[data-bg-mode="palette"]').click();
    await expect.poll(async () => (await state()).canvasBg?.mode).toBe("palette");
    const s = await state();
    // Picking it with no margin gives the background room, and the photo
    // soft corners and a shadow.
    expect(s.canvasPad).toEqual({ top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 });
    expect(s.canvasPhoto).toEqual({ radius: 15, shadow: 45 });
    await expect(window.locator('canvas[data-frame-background="palette"]')).toBeVisible();

    // 9:16 for a story: the margins widen top and bottom.
    const ratio = window.locator("[data-frame-aspect]");
    await ratio.getByRole("button", { name: "9:16" }).click();
    await expect.poll(async () => (await state()).canvasAspect).toBe("9:16");
    await expect(ratio.getByRole("button", { name: "9:16" })).toHaveAttribute("aria-pressed", "true");
    await expect(ratio.getByRole("button", { name: "Photo" })).toHaveAttribute("aria-pressed", "false");
    await window.screenshot({ path: path.join(SHOTS, "palette-9x16.png") });

    const out = await saveTo("palette.jpg");
    const { info, at } = await readPixels(out);
    expect(info.width).toBe(SRC_W + 2 * 0.08 * SRC_H);
    expect(info.width / info.height).toBeCloseTo(9 / 16, 2);
    const top = at(info.width / 2, 4), bottom = at(info.width / 2, info.height - 5);
    expect(top[2]).toBeGreaterThan(top[0] + 40); // blue
    expect(bottom[0]).toBeGreaterThan(bottom[2] + 60); // orange

    // The photo's corner is rounded off: just inside the content rect's
    // corner is background, a little further in is the white square.
    const x0 = (info.width - SRC_W) / 2, y0 = (info.height - SRC_H) / 2;
    expect(lum(at(x0 + 1, y0 + 1))).toBeLessThan(200);
    expect(lum(at(x0 + 40, y0 + 40))).toBeGreaterThan(235);
  });

  test("blur: the margin is the photo itself, blurred, at the photo's own ratio", async () => {
    await window.locator("[data-frame-aspect]").getByRole("button", { name: "Photo" }).click();
    await window.locator('[data-bg-mode="blur"]').click();
    await expect.poll(async () => (await state()).canvasBg?.mode).toBe("blur");
    expect((await state()).canvasAspect).toBeNull();
    await expect(window.getByTestId("frame-bg-blur")).toBeVisible();
    await expect(window.locator('canvas[data-frame-background="blur"]')).toBeVisible();
    await window.screenshot({ path: path.join(SHOTS, "blur.png") });

    const out = await saveTo("blur.jpg");
    const { info, at } = await readPixels(out);
    expect(info.width).toBe(SRC_W + 160);
    expect(info.height).toBe(SRC_H + 160);
    // Bottom-right margin: the photo's orange, softened — not a flat colour
    // from the old background swatches.
    const corner = at(info.width - 6, info.height - 6);
    expect(corner[0]).toBeGreaterThan(corner[2] + 40);
    // Middle of the left margin, in the blue half: blue.
    const left = at(10, 80 + SRC_H * 0.3);
    expect(left[2]).toBeGreaterThan(left[0]);
  });

  test("the backgrounds made from the photo are its colours and blur", async () => {
    await expect(window.locator("[data-frame-photo-bg] [data-bg-mode]")).toHaveCount(2);
  });

  test("the photo's corners and shadow sliders change the state as one step each", async () => {
    const before = (await state()).historyLength;
    const radius = window.getByTestId("frame-photo-radius");
    await radius.fill("0");
    await radius.dispatchEvent("pointerup");
    await expect.poll(async () => (await state()).canvasPhoto?.radius).toBe(0);
    expect((await state()).historyLength).toBe(before + 1);
    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await state()).canvasPhoto?.radius).toBe(15);
  });

  test("a text layer's background gets round corners, in the preview and in the saved file", async () => {
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
    await window.evaluate(() => window.__afterframeTest.addTextLayer("ROUND"));
    await clearToasts();
    const section = window.locator('[data-editor-section="Background"]');
    await section.getByRole("switch").click();
    await expect.poll(async () => (await state()).layers.find((l) => l.text === "ROUND")?.bgMode).toBe("solid");
    const box = window.locator('[data-text-bg="solid"]');
    await expect(box).toBeVisible();
    const radius = () => box.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
    expect(await radius()).toBe(0); // square by default
    const square = await saveTo("text-square.jpg");

    await section.getByTestId("text-bg-radius").fill("100");
    await expect.poll(async () => (await state()).layers.find((l) => l.text === "ROUND")?.bgRadius).toBe(100);
    // 100 is a pill: the radius is half the box's height.
    const rect = await box.boundingBox();
    await expect.poll(radius).toBeCloseTo(rect.height / 2, 0);
    await window.screenshot({ path: path.join(SHOTS, "text-round.png") });
    const round = await saveTo("text-round.jpg");

    // Rounding takes the box's corners off and nothing else: where the two
    // saves differ, the square one has the dark box and the round one the
    // photo showing through.
    const a = await readPixels(square), b = await readPixels(round);
    expect(b.info.width).toBe(a.info.width);
    let uncovered = 0, other = 0;
    for (let y = 0; y < a.info.height; y += 2) {
      for (let x = 0; x < a.info.width; x += 2) {
        const la = lum(a.at(x, y)), lb = lum(b.at(x, y));
        if (Math.abs(la - lb) <= 20) continue;
        if (lb > la) uncovered++;
        else other++;
      }
    }
    expect(uncovered).toBeGreaterThan(200);
    expect(other).toBeLessThan(uncovered / 20);
  });

  test("photo colours on a photo of one colour: still a gradient, lighter at the top", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), FIX_FLAT);
    await waitForEditor(window, { preview: true });
    await window.evaluate(() => window.__afterframeTest.setTool("frame"));
    await window.locator('[data-bg-mode="palette"]').click();
    await expect.poll(async () => (await state()).canvasBg?.mode).toBe("palette");

    const out = await saveTo("flat-palette.jpg");
    const { info, at } = await readPixels(out);
    const top = at(info.width / 2, 4), bottom = at(info.width / 2, info.height - 5);
    // Both ends blue, the top clearly lighter.
    expect(top[2]).toBeGreaterThan(top[0] + 40);
    expect(bottom[2]).toBeGreaterThan(bottom[0] + 40);
    expect(lum(top) - lum(bottom)).toBeGreaterThan(25);
  });

  test("a template's dark text turns light on a blurred photo, in the same undo step", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    const row = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 100 })
      .then((rows) => rows.find((r) => r.stem === "0Y1A6707-9"))); // Canon R6 Mark II, 2400×1600
    await openEditorOn(window, row, "frame");
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-full"));
    const model = async () => (await state()).layers.find((l) => l.fromPreset && l.text === "Canon EOS R6 Mark II")?.fillColor;
    await expect.poll(model).toBe("#1a1a1a");
    await window.locator('[data-bg-mode="blur"]').click();
    await expect.poll(async () => (await state()).canvasBg?.mode).toBe("blur");
    await expect.poll(model).toBe("#f4f4f4");
    await window.screenshot({ path: path.join(SHOTS, "bar-on-blur.png") });

    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await state()).canvasBg?.mode ?? null).not.toBe("blur");
    expect(await model()).toBe("#1a1a1a");
  });
});
