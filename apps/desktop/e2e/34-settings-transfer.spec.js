// Settings ▸ General ▸ Backup & transfer: export providers + API keys from one
// profile, import them into a fresh one. Native save/open dialogs are stubbed
// in the main process (same trick as 25-collage-batch).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

const PASSWORD = "transfer-pass-1";
let exportFile;

test.beforeAll(() => {
  exportFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-transfer-")), "settings.afsettings");
});

test.afterAll(() => {
  fs.rmSync(path.dirname(exportFile), { recursive: true, force: true });
});

async function openGeneralSettings(window) {
  await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  await window.keyboard.press("Meta+,");
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "General" }).click();
  await expect(window.getByText("Backup & transfer")).toBeVisible();
}

test("export with keys, then import into a fresh profile", async () => {
  const source = await launchApp({ testName: "transfer-export" });
  try {
    await source.window.evaluate(async () => {
      const mw = window.mediaWorkspace;
      await mw.saveAiPreferences({
        providers: [{ id: "p_e2e", type: "nanobanana", name: "E2E Gemini" }],
        activeProvider: "p_e2e",
      });
      await mw.setAiProviderToken("p_e2e", "gem-secret-123");
      await mw.saveAnnotationSettings({
        providers: [{ id: "a_e2e", type: "anthropic", name: "E2E Claude" }],
        activeProviderId: "a_e2e",
        maxTags: 7,
      });
      await mw.setAnnotationKey("a_e2e", "claude-secret-456");
    });
    await source.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportFile);

    await openGeneralSettings(source.window);
    await source.window.getByRole("button", { name: "Export…" }).click();
    await source.window.getByTestId("transfer-pass").fill(PASSWORD);
    await source.window.getByTestId("transfer-pass-confirm").fill("different-pass");
    await source.window.getByTestId("transfer-export-confirm").click();
    await expect(source.window.getByText("Passwords do not match")).toBeVisible();
    await source.window.getByTestId("transfer-pass-confirm").fill(PASSWORD);
    await source.window.getByTestId("transfer-export-confirm").click();
    await expect(source.window.getByTestId("transfer-export-result")).toContainText("Includes 2 API keys");
  } finally {
    await closeApp(source.app, source.userDataDir);
  }

  const text = fs.readFileSync(exportFile, "utf-8");
  expect(text).toContain("E2E Gemini");
  expect(text).not.toContain("gem-secret-123");
  expect(text).not.toContain("claude-secret-456");

  const target = await launchApp({ testName: "transfer-import" });
  try {
    await target.app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, exportFile);

    await openGeneralSettings(target.window);
    await target.window.getByRole("button", { name: "Import…" }).click();
    await expect(target.window.getByText("E2E Gemini")).toBeVisible();
    await expect(target.window.getByText(/contains 2 keys/)).toBeVisible();

    // Wrong password writes nothing.
    await target.window.getByTestId("transfer-import-pass").fill("wrong-password");
    await target.window.getByTestId("transfer-import-confirm").click();
    await expect(target.window.getByText("Incorrect password")).toBeVisible();
    expect(await target.window.evaluate(() => window.mediaWorkspace.getAiPreferences())).toEqual({});

    await target.window.getByTestId("transfer-import-pass").fill(PASSWORD);
    await target.window.getByTestId("transfer-import-confirm").click();
    await expect(target.window.getByTestId("transfer-import-result")).toContainText("Imported 2 API keys");
    await target.window.getByTestId("transfer-import-done").click();
    await target.window.waitForLoadState("domcontentloaded");

    const restored = await target.window.evaluate(async () => {
      const mw = window.mediaWorkspace;
      return {
        prefs: await mw.getAiPreferences(),
        annotation: await mw.getAnnotationSettings(),
        repaintKey: (await mw.getAiProviderToken("p_e2e"))?.token,
        annotationKey: (await mw.getAnnotationKey("a_e2e"))?.token,
      };
    });
    expect(restored.prefs.activeProvider).toBe("p_e2e");
    expect(restored.annotation.maxTags).toBe(7);
    expect(restored.repaintKey).toBe("gem-secret-123");
    expect(restored.annotationKey).toBe("claude-secret-456");

    // Stored re-encrypted for this profile, not as plaintext.
    const settingsText = fs.readFileSync(path.join(target.userDataDir, "afterframe", "settings.json"), "utf-8");
    expect(settingsText).not.toContain("gem-secret-123");
  } finally {
    await closeApp(target.app, target.userDataDir);
  }
});
