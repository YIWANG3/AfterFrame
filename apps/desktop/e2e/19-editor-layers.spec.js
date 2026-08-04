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
