// Scene depth (Depth Anything V2) — exercises the compute-depth tool +
// useSceneDepth hook + IPC depth handlers. Gated on macOS because the model
// runs on Core ML; the tool itself comes from `npm run build:native` (a
// missing build fails here rather than skipping).

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { launchApp, closeApp, waitForEditor, lacks } = require("./helpers/app");
const { REAL_IMAGE_PATHS } = require("./fixtures/make-real-images");

// SF skyline at dusk — a real photo with a genuine foreground→background depth
// gradient, so the model produces a meaningful depth map (a flat synthetic
// gradient gave the inference nothing real to estimate).
const DEPTH_FIXTURE = REAL_IMAGE_PATHS.find((p) => path.basename(p) === "0Y1A6707-9.jpg");

const onMacOS = () => process.platform === "darwin";

test.describe("Scene depth", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "depth" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    // Open a real photograph via the backdoor so depth inference runs on an
    // image with actual scene structure rather than a flat gradient.
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), DEPTH_FIXTURE);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await waitForEditor(window);
    // Switch to Text tool — that's where the Scene Depth section lives.
    // The backdoor registers in an effect a beat after Save becomes visible.
    await window.waitForFunction(() => typeof window.__afterframeTest?.setTool === "function", null, { timeout: 10_000 });
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("Generate scene depth button is reachable", async () => {
    test.skip(lacks("depth"), "scene depth is macOS-only for now (electron/capabilities.js)");
    await expect(window.getByRole("button", { name: /Generate scene depth/i })).toBeVisible();
  });

  test("clicking Generate runs depth inference and shows 'Depth ready'", async ({}, testInfo) => {
    test.skip(!onMacOS(), "Depth inference needs macOS (Core ML)");

    await window.getByRole("button", { name: /Generate scene depth/i }).click();
    // First-run model load on Apple Silicon takes ~10-30s; allow 90s to be safe
    await expect(
      window.getByRole("button", { name: /Depth ready/i }),
    ).toBeVisible({ timeout: 90_000 });
  });

  test("show-depth-map toggle becomes available after generation", async ({}, testInfo) => {
    test.skip(!onMacOS(), "Depth-dependent UI");
    // 'Show depth map' label is unique to the post-generation state
    await expect(window.getByText(/Show depth map/i)).toBeVisible();
  });
});
