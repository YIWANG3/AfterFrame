// Golden / characterization tests — crop + transform. Part of the EditorOverlay
// refactor safety net (Phase 0): they PIN current behavior (output dimensions +
// transform state + undo/redo) so the decomposition can't silently change it.
// Drive via the __afterframeTest backdoor + real crop-panel buttons; assert on
// the saved file with sharp.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-golden-tf-"));
const out = (n) => path.join(tmp, n);
const save = (window, p) => window.evaluate((x) => window.__afterframeTest.saveAs(x), p);
const state = (window) => window.evaluate(() => window.__afterframeTest.getState());

async function waitPreview(window) {
  await window.waitForFunction(() => typeof window.__afterframeTest?.getPreviewReady === "function", null, { timeout: 10_000 });
  await expect
    .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady()), { timeout: 10_000 })
    .toBe(true);
}

test.describe("Golden: crop + transform", () => {
  let app, window, userDataDir, srcW, srcH;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    const m = await sharp(fixturePath).metadata();
    srcW = m.width; srcH = m.height;
    ({ app, window, userDataDir } = await launchApp({ testName: "golden-tf" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("crop"));
    await waitPreview(window);
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("baseline: no edits → source dimensions preserved", async () => {
    await save(window, out("base.jpg"));
    const m = await sharp(out("base.jpg")).metadata();
    expect(m.width).toBe(srcW);
    expect(m.height).toBe(srcH);
  });

  test("rotate 90° L → dims swap + quarterTurns state; undo/redo reverts", async () => {
    await window.getByRole("button", { name: /90° L/ }).click();
    await window.waitForTimeout(400);
    expect((await state(window)).quarterTurns).not.toBe(0);

    await save(window, out("rot.jpg"));
    const m = await sharp(out("rot.jpg")).metadata();
    expect(m.width).toBe(srcH);
    expect(m.height).toBe(srcW);

    // transform history (Cmd+Z path)
    await window.evaluate(() => window.__afterframeTest.undo());
    await window.waitForTimeout(300);
    expect((await state(window)).quarterTurns).toBe(0);
    await window.evaluate(() => window.__afterframeTest.redo());
    await window.waitForTimeout(300);
    expect((await state(window)).quarterTurns).not.toBe(0);

    // leave clean for the next test
    await window.evaluate(() => window.__afterframeTest.undo());
    await window.waitForTimeout(300);
    expect((await state(window)).quarterTurns).toBe(0);
  });

  test("flip H → flipX toggles, dimensions unchanged", async () => {
    const before = (await state(window)).flipX;
    await window.getByRole("button", { name: /Flip H/i }).click();
    await window.waitForTimeout(300);
    expect((await state(window)).flipX).toBe(!before);

    await save(window, out("flip.jpg"));
    const m = await sharp(out("flip.jpg")).metadata();
    expect(m.width).toBe(srcW);
    expect(m.height).toBe(srcH);

    await window.getByRole("button", { name: /Flip H/i }).click(); // restore
    await window.waitForTimeout(200);
    expect((await state(window)).flipX).toBe(before);
  });

  test("aspect 1:1 → cropped output is square", async () => {
    await window.evaluate(() => window.__afterframeTest.setAspect("1:1"));
    await window.waitForTimeout(400);
    expect((await state(window)).aspectKey).toBe("1:1");

    await save(window, out("square.jpg"));
    const m = await sharp(out("square.jpg")).metadata();
    // centered 1:1 crop → within rounding of square
    expect(Math.abs(m.width - m.height)).toBeLessThanOrEqual(2);
    expect(m.width).toBeLessThan(srcW); // actually cropped, not full frame
  });
});
