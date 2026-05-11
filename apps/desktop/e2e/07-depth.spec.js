// Scene depth (Depth Anything V2) — exercises the swift CLI + useSceneDepth
// hook + IPC depth handlers. Gated on macOS + Xcode toolchain because the
// model needs swift to run.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const { launchApp, closeApp } = require("./helpers/app");

const isMacOSWithXcode = () =>
  process.platform === "darwin" &&
  fs.existsSync("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift");

test.describe("Scene depth", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "depth" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    // Open a fixture image via the test catalog. Select + E keyboard shortcut.
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
    await window.locator("[data-gallery-item='true']").first().click();
    await window.keyboard.press("e");
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    // Switch to Text tool — that's where the Scene Depth section lives
    await window.evaluate(() => window.__afterframeTest.setTool("text"));
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("Generate scene depth button is reachable", async () => {
    await expect(window.getByRole("button", { name: /Generate scene depth/i })).toBeVisible();
  });

  test("clicking Generate runs depth inference and shows 'Depth ready'", async ({}, testInfo) => {
    test.skip(!isMacOSWithXcode(), "Depth inference needs macOS + Xcode toolchain");

    await window.getByRole("button", { name: /Generate scene depth/i }).click();
    // First-run model load on Apple Silicon takes ~10-30s; allow 90s to be safe
    await expect(
      window.getByRole("button", { name: /Depth ready/i }),
    ).toBeVisible({ timeout: 90_000 });
  });

  test("show-depth-map toggle becomes available after generation", async ({}, testInfo) => {
    test.skip(!isMacOSWithXcode(), "Depth-dependent UI");
    // 'Show depth map' label is unique to the post-generation state
    await expect(window.getByText(/Show depth map/i)).toBeVisible();
  });
});
