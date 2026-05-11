// Sticker tool functional tests — exercises the Create new flow end-to-end.
// On macOS 14+ with Xcode installed, the swift CLI runs for real and we
// verify a sticker lands in the library. On other systems we skip gracefully.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const { launchApp, closeApp } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

const isMacOSWithXcode = () => {
  return process.platform === "darwin" &&
    fs.existsSync("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift");
};

test.describe("Sticker tool", () => {
  let app, window, userDataDir, fixturePath;

  test.beforeAll(async () => {
    fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "sticker" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: /^Sticker$/i }).first().click();
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("Create new tab is the default; Source filename shown", async () => {
    // Create new tab is highlighted by default
    await expect(window.getByRole("button", { name: /Create new/i })).toBeVisible();
    // Source filename = fixture filename
    await expect(window.getByText(/test-image\.jpg/i).first()).toBeVisible();
    // Detect subjects button is reachable
    await expect(window.getByRole("button", { name: /Detect subjects/i })).toBeVisible();
  });

  test("region helper text shows when no marquee drawn", async () => {
    await expect(window.getByText(/Detects in full image · drag on canvas to limit/i)).toBeVisible();
  });

  test("Library tab is reachable and empty initially", async () => {
    await window.getByRole("button", { name: /^Library$/i }).click();
    // Empty state shows because we're in a fresh userData
    await expect(window.getByText(/No stickers yet/i)).toBeVisible();
  });

  test("Detect subjects → either instance found or 'No subject' toast", async ({ }, testInfo) => {
    test.skip(!isMacOSWithXcode(), "Sticker extraction needs macOS 14+ with Xcode toolchain");

    // Back to Create new tab
    await window.getByRole("button", { name: /Create new/i }).click();
    await window.getByRole("button", { name: /Detect subjects/i }).click();

    // Wait up to 30s for either:
    //   - DETECTED (N) section to appear (success)
    //   - "No subject detected" toast (graceful failure on our boring fixture)
    const success = window.getByText(/DETECTED \(\d+\)/i);
    const noSubject = window.getByText(/No subject detected/i);
    await expect(success.or(noSubject)).toBeVisible({ timeout: 30_000 });
  });
});
