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
