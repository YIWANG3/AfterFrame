// AI handwriting sticker — full chain against the mock provider:
// modal → run-text-image-job (sidecar renders text locally) → luminance matte
// → colorize → sticker layer on the canvas. No network, no API keys.

const path = require("node:path");
const fs = require("node:fs");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

const state = (window) => window.evaluate(() => window.__afterframeTest.getState());
const layerCount = (window) => window.evaluate(() => window.__afterframeTest.getLayerCount());

test.describe("AI handwriting sticker (mock provider)", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    const fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "handwriting" }));

    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });

    // The modal lists provider instances from aiPreferences; the "mock" type
    // can't be created through the UI, so seed it through the app's own
    // settings IPC (a raw settings.json write races the app's startup writes).
    await window.evaluate(() =>
      window.mediaWorkspace.saveAiPreferences({
        providers: [{ id: "p_mock", type: "mock", name: "Mock (local)" }],
        activeProvider: "p_mock",
      })
    );
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  test("generate via mock → matte → add as sticker layer", async () => {
    await window.getByTitle("AI handwriting").click();
    const input = window.getByTestId("handwriting-text-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("让子弹飞");

    // Mock provider needs no key, so Generate must be enabled without any
    // token configured.
    const generate = window.getByTestId("handwriting-generate");
    await expect(generate).toBeEnabled({ timeout: 5_000 });
    await generate.click();

    // The candidate renders as a recolored alpha sticker once the sidecar job
    // finishes (local PIL render — seconds, not minutes).
    await expect(window.getByTestId("handwriting-candidate-0")).toBeVisible({ timeout: 30_000 });

    await window.getByTestId("handwriting-add").click();
    await expect.poll(() => layerCount(window), { timeout: 5_000 }).toBe(1);

    const s = await state(window);
    const layer = s.layers[0];
    expect(layer.type).toBe("sticker");
    expect(layer.stickerPathKind).toBe("data");
    expect(layer.handwriting?.text).toBe("让子弹飞");
    expect(layer.handwriting?.provider).toBe("mock");
    expect(layer.naturalWidth).toBeGreaterThan(0);
    expect(layer.naturalHeight).toBeGreaterThan(0);
  });
});
