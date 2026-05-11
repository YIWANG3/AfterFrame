// Demo / "watch me" spec — same coverage as the real suite, but slowed
// down so a human can follow along. Not run by default; invoke with:
//   DEMO=1 npx playwright test demo.spec.js
//
// Each step has an explicit pause so the Electron window stays on screen
// long enough to see what just happened. Total runtime ~60-90s.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { launchApp, closeApp } = require("./helpers/app");

const BEAT = 1200; // ms between visible steps

test.describe.configure({ mode: "serial" });

test.skip(!process.env.DEMO, "set DEMO=1 to run the slow walkthrough");

test.describe("Demo (slow walkthrough)", () => {
  let app, window, userDataDir;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-demo-"));

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "demo" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("01 — app launches and gallery shows 10 seeded images", async () => {
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
    const count = await window.locator("[data-gallery-item='true']").count();
    expect(count).toBe(10);
    await window.waitForTimeout(BEAT);
  });

  test("02 — sidebar nav: jump to Stickers view, then back", async () => {
    await window.getByRole("button", { name: /Stickers/i }).first().click();
    await window.waitForTimeout(BEAT);
    await window.getByRole("button", { name: /All Assets/i }).first().click();
    await window.waitForTimeout(BEAT);
  });

  test("03 — select first card (you should see the accent ring)", async () => {
    const firstCard = window.locator("[data-gallery-item='true']").first();
    await firstCard.click();
    await expect(firstCard.locator(".ring-accent").first()).toBeVisible();
    await window.waitForTimeout(BEAT);
  });

  test("04 — press E to open the editor", async () => {
    await window.keyboard.press("e");
    await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
    await window.waitForTimeout(BEAT);
  });

  test("05 — tour each tool panel: Crop → Text → Sticker → AI Repaint", async () => {
    // Crop is the default; just dwell
    await expect(window.getByText(/Aspect Ratio/i).first()).toBeVisible();
    await window.waitForTimeout(BEAT);

    await window.getByRole("button", { name: /^Text$/i }).first().click();
    await expect(window.getByText(/PRESETS/i).first()).toBeVisible();
    await window.waitForTimeout(BEAT);

    await window.getByRole("button", { name: /^Sticker$/i }).first().click();
    await expect(window.getByRole("button", { name: /Create new/i })).toBeVisible();
    await window.waitForTimeout(BEAT);

    await window.getByRole("button", { name: /AI Repaint/i }).first().click();
    await window.waitForTimeout(BEAT);
  });

  test("06 — back to Text tool, add a text layer via backdoor", async () => {
    await window.getByRole("button", { name: /^Text$/i }).first().click();
    await window.waitForTimeout(BEAT);
    const result = await window.evaluate(() => window.__afterframeTest.addTextLayer("DEMO RUN"));
    expect(result.count).toBeGreaterThan(0);
    // Let the new layer render
    await window.waitForTimeout(BEAT * 2);
  });

  test("07 — save the edited image (canvas path with text layer)", async () => {
    const out = path.join(tmpDir, "demo-output.jpg");
    await window.evaluate(async (p) => { await window.__afterframeTest.saveAs(p); }, out);
    expect(fs.existsSync(out)).toBe(true);
    console.log(`[demo] wrote ${out} (${fs.statSync(out).size} bytes)`);
    await window.waitForTimeout(BEAT);
  });

  test("08 — close editor", async () => {
    await window.evaluate(() => window.__afterframeTest.closeEditor());
    await window.waitForTimeout(BEAT);
  });
});
