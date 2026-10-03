// Sticker tool functional tests — exercises the Create new flow end-to-end.
// On macOS 14+ the extract-sticker tool runs for real and we verify a
// sticker lands in the library. On other systems we skip gracefully. The tool
// comes from `npm run build:native`; a missing build fails rather than skips.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

// macOS 14 (Darwin 23) is where Vision's subject lifting starts.
const onMacOS14 = () => process.platform === "darwin" && Number(os.release().split(".")[0]) >= 23;

test.describe("Sticker tool", () => {
  let app, window, userDataDir, fixturePath;

  test.beforeAll(async () => {
    fixturePath = await ensureFixture();
    ({ app, window, userDataDir } = await launchApp({ testName: "sticker" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await waitForEditor(window);
    await window.getByRole("button", { name: /^Sticker$/i }).first().click();
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("detection is immediately available for the open image", async () => {
    // The source is identified by the editor header; creation has no tab.
    await expect(window.getByText(/test-image\.jpg/i).first()).toBeVisible();
    // Detect subjects button is reachable
    await expect(window.getByRole("button", { name: /Detect subjects/i })).toBeVisible();
  });

  test("region helper text shows when no marquee drawn", async () => {
    await expect(window.getByText("Detects the whole image. Drag a box on the canvas to limit it.")).toBeVisible();
  });

  test("library appears below detection and is empty initially", async () => {
    await expect(window.getByRole("heading", { name: /^Library$/i })).toBeVisible();
    // Empty state shows because we're in a fresh userData
    await expect(window.getByText(/No stickers yet/i)).toBeVisible();
  });

  test("Detect subjects → either instance found or 'No subject' toast", async ({ }, testInfo) => {
    test.skip(!onMacOS14(), "Sticker extraction needs macOS 14+");
    // The first Vision request on a cold CI runner is slow: this passed at
    // 21.7 s on one run and timed out at 30 s on the next, on a run where the
    // whole suite took 14 minutes instead of 10. Locally it takes about 2 s.
    test.setTimeout(150_000);

    await window.getByRole("button", { name: /Detect subjects/i }).click();

    // Wait for either:
    //   - DETECTED (N) section to appear (success)
    //   - "No subject detected" toast (graceful failure on our boring fixture)
    const success = window.getByText(/DETECTED \(\d+\)/i);
    const noSubject = window.getByText(/No subject detected/i);
    await expect(success.or(noSubject)).toBeVisible({ timeout: 120_000 });
  });
});

// Real detection path — gated on macOS 14+ like 43-sticker-library.
// This is the regression guard for the media-allowlist class of bugs: the
// detect-scratch dir lives under the system temp root, and a previous release
// 403'd every cutout preview (broken-image icons) while the SCRIPTED tests
// passed — they never asserted the images actually decode.

test.describe("Sticker detection (real extract-sticker run)", () => {
  test("detected cutouts actually render — media:// allowlist guard", async () => {
    test.skip(!onMacOS14(), "needs macOS 14+");
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
      await waitForEditor(window);
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
      const cutouts = window.getByTestId("detected-sticker-grid").locator("img");
      await expect(cutouts).toHaveCount(count);
      await expect.poll(async () => cutouts.evaluateAll(images =>
        images.every(img => img.complete && img.naturalWidth > 0),
      ), { timeout: 15000 }).toBe(true);

      fs.rmSync(subjectPath, { force: true });
    } finally {
      await closeApp(app, userDataDir);
    }
  });
});
