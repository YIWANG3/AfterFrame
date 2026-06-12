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

// Real detection path — gated on the Swift/VisionKit toolchain like 07-depth.
// This is the regression guard for the media-allowlist class of bugs: the
// detect-scratch dir lives under the system temp root, and a previous release
// 403'd every cutout preview (broken-image icons) while the SCRIPTED tests
// passed — they never asserted the images actually decode.
const os = require("node:os");

test.describe("Sticker detection (real swift run)", () => {
  test("detected cutouts actually render — media:// allowlist guard", async () => {
    test.skip(!isMacOSWithXcode(), "needs macOS + Xcode toolchain");
    test.setTimeout(120_000);

    const { app, window, userDataDir } = await launchApp({ testName: "sticker-detect" });
    try {
      // A subject VisionKit can lift: solid high-contrast disc on plain ground
      const sharp = require("sharp");
      const subjectPath = path.join(os.tmpdir(), `af-sticker-subject-${Date.now()}.png`);
      const disc = Buffer.from(
        `<svg width="600" height="600"><rect width="600" height="600" fill="#f4f4f4"/>` +
        `<circle cx="300" cy="300" r="150" fill="#c0392b"/></svg>`,
      );
      await sharp(disc).png().toFile(subjectPath);

      await window.waitForFunction(() => !!window.__afterframeTest?.openEditor, null, { timeout: 15_000 });
      await window.evaluate((p) => window.__afterframeTest.openEditor(p), subjectPath);
      await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
      await window.waitForFunction(() => typeof window.__afterframeTest?.setTool === "function", null, { timeout: 10_000 });
      await window.evaluate(() => window.__afterframeTest.setTool("sticker"));

      await window.getByRole("button", { name: /Detect subjects/i }).click();
      // First run loads the VisionKit model — allow generous time
      await expect(window.getByText(/Detected \(\d+\)/i)).toBeVisible({ timeout: 90_000 });

      const detectedLabel = await window.getByText(/Detected \(\d+\)/i).textContent();
      const count = Number(detectedLabel.match(/\((\d+)\)/)[1]);
      test.skip(count === 0, "VisionKit found no subject in the synthetic image");

      // THE assertion that was missing: every cutout thumbnail must decode.
      // A 403 from the media allowlist leaves naturalWidth === 0.
      const widths = await window.evaluate(() => {
        const grid = document.querySelectorAll(".grid img");
        return [...grid].map((img) => img.naturalWidth);
      });
      expect(widths.length).toBeGreaterThan(0);
      for (const w of widths) expect(w).toBeGreaterThan(0);

      fs.rmSync(subjectPath, { force: true });
    } finally {
      await closeApp(app, userDataDir);
    }
  });
});
