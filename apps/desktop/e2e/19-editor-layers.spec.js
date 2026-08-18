// Golden / characterization tests — text layer operations. Part of the
// EditorOverlay refactor safety net (Phase 0). Pins add / reorder / delete +
// selection via getState(), so the text-tool extraction can't change it.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

const state = (window) => window.evaluate(() => window.__afterframeTest.getState());
const layerCount = (window) => window.evaluate(() => window.__afterframeTest.getLayerCount());
const firstId = (window) => window.evaluate(() => window.__afterframeTest.getState().layers[0]?.id);

test.describe("Golden: text layers", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "golden-layers" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  test("add two text layers → count + order", async () => {
    // addTextLayer reads the `layers` closure; wait for the commit to re-render
    // between adds so the second doesn't clobber the first (stale-closure race).
    const a = await window.evaluate(() => window.__afterframeTest.addTextLayer("Alpha"));
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(1);
    const b = await window.evaluate(() => window.__afterframeTest.addTextLayer("Bravo"));
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(2);

    const s = await state(window);
    expect(s.layers.length).toBe(2);
    expect(s.layers.map((l) => l.id)).toEqual([a.id, b.id]); // insertion order
    expect(s.layers.every((l) => l.type === "text")).toBe(true);
  });

  test("reorder: move first layer up one → order swaps", async () => {
    const before = (await state(window)).layers.map((l) => l.id);
    await window.evaluate((id) => window.__afterframeTest.moveLayer(id, +1), before[0]);
    await expect.poll(() => firstId(window), { timeout: 5000 }).toBe(before[1]);
    const after = (await state(window)).layers.map((l) => l.id);
    expect(after).toEqual([before[1], before[0]]);
  });

  test("delete a layer → count drops, survivor intact", async () => {
    const ids = (await state(window)).layers.map((l) => l.id);
    await window.evaluate((id) => window.__afterframeTest.deleteLayer(id), ids[0]);
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(1);
    expect(await firstId(window)).toBe(ids[1]);
  });

  test("select a layer → getState reflects selection", async () => {
    const id = (await state(window)).layers[0].id;
    await window.evaluate((x) => window.__afterframeTest.selectLayers([x]), id);
    await window.waitForTimeout(150);
    expect((await state(window)).selectedIds).toContain(id);
  });
});

test.describe("Overlay layers", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "overlay-layers" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  test("adds multiple overlays, reorders them, and Apply bakes them into the crop source", async () => {
    const addOverlay = window.getByTitle("Add overlay layer");
    await expect(addOverlay).toBeVisible();
    await addOverlay.click();
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(1);
    await addOverlay.click();
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(2);
    await expect(window.locator('[data-editor-layer-type="overlay"]')).toHaveCount(2);

    const beforeOrder = (await state(window)).layers.map((layer) => layer.id);
    expect((await state(window)).layers.every((layer) => layer.type === "overlay")).toBe(true);
    await window.evaluate((id) => window.__afterframeTest.moveLayer(id, 1), beforeOrder[0]);
    await expect.poll(async () => (await state(window)).layers[0]?.id, { timeout: 5000 }).toBe(beforeOrder[1]);

    const beforePixel = await window.evaluate(() => window.__afterframeTest.sampleSourcePixel(0.5, 0.9));
    await window.getByRole("button", { name: /Apply/i }).click();
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(0);
    const afterPixel = await window.evaluate(() => window.__afterframeTest.sampleSourcePixel(0.5, 0.9));
    expect(afterPixel.slice(0, 3).reduce((sum, value) => sum + value, 0))
      .toBeLessThan(beforePixel.slice(0, 3).reduce((sum, value) => sum + value, 0));

    await window.evaluate(() => window.__afterframeTest.setTool("crop"));
    expect(await window.evaluate(() => window.__afterframeTest.sampleSourcePixel(0.5, 0.9))).toEqual(afterPixel);
  });
});

// One overlay model: the wash a frame preset ships with IS an overlay layer,
// with the same paint controls (solid / multi-stop gradient) plus a coverage
// (edge + how far the wash reaches). Guards that the preset's scrim arrives
// as an editable overlay with its edge/coverage, that editing coverage/edge
// moves the live element the way the export math does, and that the picker
// can add a third gradient stop.
test.describe("Overlay coverage + multi-stop gradient", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "overlay-coverage" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady?.()), { timeout: 10_000 })
      .toBe(true);
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  const overlayEl = () => window.locator('[data-editor-layer-type="overlay"]').first();
  const box = async () => {
    const b = await overlayEl().boundingBox();
    return b;
  };

  test("a frame preset's scrim is a normal overlay layer with edge + coverage", async () => {
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("overlay-exif"));
    await expect.poll(async () => (await state(window)).layers.filter((l) => l.type === "overlay").length, { timeout: 5000 }).toBe(1);
    const scrim = (await state(window)).layers.find((l) => l.type === "overlay");
    expect(scrim.fromPreset).toBe(true);
    expect(scrim.edge).toBe("bottom");
    expect(scrim.coverage).toBeCloseTo(0.32, 5);
    expect(scrim.mode).toBe("gradient");
    expect(scrim.gradientStops).toHaveLength(2);
    // Template stops run inner (transparent) → edge (dark).
    expect(scrim.gradientStops[0].opacity).toBe(0);
    expect(scrim.gradientStops[1].opacity).toBeCloseTo(0.5, 5);
    // The live element only covers 32% of the photo's height.
    const content = (await state(window)).outputContentRect;
    const b = await box();
    expect(b.height / content.height).toBeCloseTo(0.32, 1);
    expect(b.width / content.width).toBeCloseTo(1, 1);
  });

  test("coverage + edge edits move the live overlay element", async () => {
    const scrimId = (await state(window)).layers.find((l) => l.type === "overlay").id;
    await window.evaluate((id) => window.__afterframeTest.selectLayers([id]), scrimId);
    const coverage = async () => (await state(window)).layers.find((l) => l.id === scrimId).coverage;
    const edge = async () => (await state(window)).layers.find((l) => l.id === scrimId).edge;

    // 100% = the whole photo; use that as the reference frame for the edges.
    const slider = window.locator('input[type="range"][min="5"][max="100"]').first();
    await expect(slider).toBeVisible();
    await slider.fill("100");
    await expect.poll(coverage, { timeout: 5000 }).toBe(1);
    const full = await box();

    // 60% from the bottom: bottom edges line up, height shrinks.
    await slider.fill("60");
    await expect.poll(coverage, { timeout: 5000 }).toBeCloseTo(0.6, 5);
    let b = await box();
    expect(b.height / full.height).toBeCloseTo(0.6, 1);
    expect(b.y + b.height).toBeCloseTo(full.y + full.height, 0);

    // Switch the edge to "top": the same 60% now hangs from the top.
    await window.getByTitle("From top").click();
    await expect.poll(edge, { timeout: 5000 }).toBe("top");
    b = await box();
    expect(b.y).toBeCloseTo(full.y, 0);
    expect(b.height / full.height).toBeCloseTo(0.6, 1);

    // "left": coverage becomes a width fraction.
    await window.getByTitle("From left").click();
    await expect.poll(edge, { timeout: 5000 }).toBe("left");
    b = await box();
    expect(b.x).toBeCloseTo(full.x, 0);
    expect(b.width / full.width).toBeCloseTo(0.6, 1);
    expect(b.height / full.height).toBeCloseTo(1, 1);
  });

  test("the picker adds a third gradient stop where the bar is clicked", async () => {
    const scrimId = (await state(window)).layers.find((l) => l.type === "overlay").id;
    await window.evaluate((id) => window.__afterframeTest.selectLayers([id]), scrimId);
    await window.getByTitle("Edit gradient").first().click();
    const bar = window.locator('[aria-label^="Gradient stop"]').first().locator("..").locator("div").first();
    await expect(bar).toBeVisible();
    await expect(window.locator('[aria-label^="Gradient stop"]')).toHaveCount(2);
    const bb = await bar.boundingBox();
    await window.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height / 2);
    await expect(window.locator('[aria-label^="Gradient stop"]')).toHaveCount(3);
    const stops = (await state(window)).layers.find((l) => l.id === scrimId).gradientStops;
    expect(stops).toHaveLength(3);
    expect(stops[1].pos).toBeGreaterThan(0.35);
    expect(stops[1].pos).toBeLessThan(0.65);
    // Inserted stop starts invisible: interpolated between its neighbours.
    expect(stops[1].opacity).toBeGreaterThan(0);
    expect(stops[1].opacity).toBeLessThan(0.5);
    await window.keyboard.press("Escape");
  });
});

// Unified history: transform edits AND layer edits share ONE undo/redo timeline,
// so the global undo (Cmd+Z / backdoor.undo) reverses whichever was last — not a
// separate layer-only stack. Also guards that a frame preset is a single atomic
// undo step (canvas margins + its layers committed together).
const historyLen = (window) => window.evaluate(() => window.__afterframeTest.getState().historyLength);
const padBottom = (window) => window.evaluate(() => window.__afterframeTest.getState().canvasPad?.bottom || 0);

test.describe("Unified undo/redo (transform + layers, one timeline)", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "unified-undo" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => window.evaluate(() => window.__afterframeTest.getPreviewReady?.()), { timeout: 10_000 })
      .toBe(true);
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  test("global undo reverses a text-layer add; redo re-applies (same stack)", async () => {
    const len0 = await historyLen(window);
    await window.evaluate(() => window.__afterframeTest.addTextLayer("Undo me"));
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(1);
    await expect.poll(() => historyLen(window), { timeout: 5000 }).toBe(len0 + 1);

    // The GLOBAL undo (what Cmd+Z drives) must remove the layer — proving layers
    // ride the same timeline as transform edits, not a separate stack.
    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(0);

    await window.evaluate(() => window.__afterframeTest.redo());
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBe(1);
  });

  test("applying a frame preset is a single atomic undo (margins + layers)", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({})); // ensure no border
    const len0 = await historyLen(window);
    await window.evaluate(() => window.__afterframeTest.applyFramePreset("bar-id"));
    await expect.poll(() => padBottom(window), { timeout: 5000 }).toBeGreaterThan(0.05);
    // ONE entry, not two — pad + layers committed together.
    await expect.poll(() => historyLen(window), { timeout: 5000 }).toBe(len0 + 1);

    // A single undo reverses the whole preset (margin gone).
    await window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(() => padBottom(window), { timeout: 5000 }).toBe(0);
  });

  test("rapid panel edits collapse into a single undo step (coalesced)", async () => {
    await window.evaluate(() => window.__afterframeTest.setPad({}));
    // Ensure a text layer exists + is the inspector target (fontSize field).
    await window.evaluate(() => window.__afterframeTest.addTextLayer("scrub"));
    await expect.poll(() => layerCount(window), { timeout: 5000 }).toBeGreaterThan(0);

    // The fontSize field is the only number input with max=2000.
    const input = window.locator('input[type="number"][max="2000"]').first();
    await expect(input).toBeVisible({ timeout: 5000 });
    const len0 = await historyLen(window);

    // Type several digits quickly → several onChange ticks within the debounce
    // window = one gesture.
    await input.focus();
    await input.press("Control+a");
    await input.pressSequentially("120", { delay: 60 });

    // After the debounce settles, the whole run is exactly ONE history entry.
    await expect.poll(() => historyLen(window), { timeout: 5000 }).toBe(len0 + 1);
  });
});
