// The crop tool driven by the mouse — handles, pan, wheel zoom and the angle
// ruler. 18-editor-transform covers the same state through buttons and the
// backdoor; the pointer paths (useCropTool.beginCropResize / beginImagePan /
// handlePointerMove, useViewportWheel, AngleRuler's pointer handlers,
// cropMath.symmetricResize) had never run under e2e (coverage report B4).
// Coordinates: getState().cropRect is in viewport space; the viewport's
// bounding box turns it into page coordinates for Playwright's mouse.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

let ctx;
const state = () => ctx.window.evaluate(() => window.__afterframeTest.getState());
const viewport = () => ctx.window.locator("[data-editor-viewport='true']");

async function geometry() {
  const box = await viewport().boundingBox();
  const s = await state();
  const r = s.cropRect;
  return {
    s, box, r,
    page: (x, y) => ({ x: box.x + x, y: box.y + y }),
    // Handle divs are 24 px squares glued to the frame's corners/edges.
    handle: (key) => {
      const cx = key.includes("w") ? r.x + 12 : key.includes("e") ? r.x + r.width - 12 : r.x + r.width / 2;
      const cy = key.includes("n") ? r.y + 12 : key.includes("s") ? r.y + r.height - 12 : r.y + r.height / 2;
      return { x: box.x + cx, y: box.y + cy };
    },
  };
}

async function drag(from, to, steps = 12) {
  await ctx.window.mouse.move(from.x, from.y);
  await ctx.window.mouse.down();
  await ctx.window.mouse.move(to.x, to.y, { steps });
  await ctx.window.mouse.up();
}

test.beforeAll(async () => {
  const fixturePath = await ensureFixture();
  ctx = await launchApp({ testName: "crop-mouse" });
  await ctx.window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  await ctx.window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
  await expect(ctx.window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(ctx.window, { preview: true });
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("crop"));
  await ctx.window.evaluate(() => window.__afterframeTest.setAspect("free"));
  await expect.poll(async () => (await state()).aspectKey).toBe("free");
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("dragging a corner handle shrinks the crop symmetrically and records one undo step", async () => {
  const before = await geometry();
  const from = before.handle("se");
  await drag(from, { x: from.x - 80, y: from.y - 60 });
  const after = await geometry();
  expect(after.r.width).toBeLessThan(before.r.width - 100);
  expect(after.r.height).toBeLessThan(before.r.height - 80);
  // Symmetric about the centre: the box's midpoint does not move.
  expect(Math.abs((after.r.x + after.r.width / 2) - (before.r.x + before.r.width / 2))).toBeLessThan(2);
  expect(after.s.historyLength).toBe(before.s.historyLength + 1);
  await expect(ctx.window.locator("[data-crop-handle]")).toHaveCount(8);
});

test("an edge handle changes one dimension only while the aspect is free", async () => {
  const before = await geometry();
  const from = before.handle("e");
  await drag(from, { x: from.x - 50, y: from.y + 40 });
  const after = await geometry();
  expect(after.r.width).toBeLessThan(before.r.width - 60);
  expect(Math.abs(after.r.height - before.r.height)).toBeLessThan(2);
});

test("a fixed aspect keeps the ratio through a corner drag", async () => {
  await ctx.window.evaluate(() => window.__afterframeTest.setAspect("1:1"));
  await expect.poll(async () => (await state()).aspectKey).toBe("1:1");
  const before = await geometry();
  expect(Math.abs(before.r.width - before.r.height)).toBeLessThan(2);
  const from = before.handle("nw");
  await drag(from, { x: from.x + 40, y: from.y + 10 });
  const after = await geometry();
  expect(after.r.width).toBeLessThan(before.r.width);
  expect(Math.abs(after.r.width - after.r.height)).toBeLessThan(2);
  await ctx.window.evaluate(() => window.__afterframeTest.setAspect("free"));
});

test("the wheel is a workspace zoom: crop and photo scale together about the crop centre", async () => {
  const before = await geometry();
  const centre = before.page(before.r.x + before.r.width / 2, before.r.y + before.r.height / 2);
  await ctx.window.mouse.move(centre.x, centre.y);
  await ctx.window.mouse.wheel(0, -240);
  await expect.poll(async () => (await state()).imageZoom, { timeout: 5_000 }).toBeGreaterThan(before.s.imageZoom + 0.05);
  const after = await geometry();
  const factor = after.s.imageZoom / before.s.imageZoom;
  expect(after.r.width / before.r.width).toBeCloseTo(factor, 2);
  expect(after.r.height / before.r.height).toBeCloseTo(factor, 2);
  expect(Math.abs((after.r.x + after.r.width / 2) - (before.r.x + before.r.width / 2))).toBeLessThan(1);
  // The commit is debounced (160 ms): the gesture lands as one history entry.
  await expect.poll(async () => (await state()).historyLength, { timeout: 5_000 }).toBe(before.s.historyLength + 1);
});

test("dragging inside the crop pans the photo and leaves the crop where it is", async () => {
  // setAspect re-centres a full-size crop, so shrink it first: the placement
  // clamp only leaves room to pan when the crop is smaller than the photo.
  const full = await geometry();
  const corner = full.handle("se");
  await drag(corner, { x: corner.x - 120, y: corner.y - 90 });
  const before = await geometry();
  expect(before.r.width).toBeLessThan(before.s.imageRect.width - 100);
  // A south-east handle drag leaves the photo glued to the crop's top-left
  // corner, so the only slack is to the left/up; the clamp blocks the rest.
  const centre = before.page(before.r.x + before.r.width / 2, before.r.y + before.r.height / 2);
  await drag(centre, { x: centre.x - 30, y: centre.y - 20 });
  const after = await geometry();
  expect(after.r).toEqual(before.r);
  expect(before.s.imageOffsetX - after.s.imageOffsetX).toBeGreaterThan(20);
  expect(before.s.imageOffsetY - after.s.imageOffsetY).toBeGreaterThan(10);
  expect(after.s.historyLength).toBe(before.s.historyLength + 1);
});

test("the angle ruler straightens by drag and double-click resets to 0°", async () => {
  const ruler = ctx.window.getByTestId("angle-ruler");
  await expect(ruler).toBeVisible();
  const box = await ruler.boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await state();
  expect(before.freeAngle).toBe(0);
  // 600 px track over ±45° → 6.67 px per degree; +50 px ≈ +7.5°.
  await drag(centre, { x: centre.x + 50, y: centre.y });
  const turned = await state();
  expect(turned.freeAngle).toBeGreaterThan(6.5);
  expect(turned.freeAngle).toBeLessThan(8.5);
  expect(turned.historyLength).toBe(before.historyLength + 1);

  await ctx.window.mouse.dblclick(centre.x, centre.y);
  await expect.poll(async () => (await state()).freeAngle, { timeout: 5_000 }).toBe(0);
  expect((await state()).historyLength).toBe(before.historyLength + 2);

  // Undo walks the same timeline back to the straightened state.
  await ctx.window.evaluate(() => window.__afterframeTest.undo());
  await expect.poll(async () => (await state()).freeAngle, { timeout: 5_000 }).toBeCloseTo(turned.freeAngle, 1);
});

test("the export honours a mouse-made crop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-crop-mouse-"));
  try {
    await ctx.window.evaluate(() => window.__afterframeTest.setAspect("1:1"));
    await expect.poll(async () => (await state()).aspectKey).toBe("1:1");
    const out = path.join(tmp, "square.jpg");
    await ctx.window.evaluate((p) => window.__afterframeTest.saveAs(p), out);
    await expect.poll(() => fs.existsSync(out), { timeout: 20_000 }).toBe(true);
    const sharp = require("sharp");
    const meta = await sharp(out).metadata();
    expect(Math.abs(meta.width - meta.height)).toBeLessThanOrEqual(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
