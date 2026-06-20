// "Open with" external-editor submenu in the gallery context menu.
// Editors are auto-detected from /Applications, so the submenu only appears
// when the test machine has a known editor installed — guard accordingly so
// CI without editors doesn't fail. We never click an editor (that would launch
// a real app); we only verify the submenu surfaces a detected editor.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

test.describe("Open with external editor", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "openwith" }));
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("detect-editors IPC returns a list", async () => {
    const editors = await window.evaluate(() => window.mediaWorkspace?.detectEditors?.());
    expect(Array.isArray(editors)).toBe(true);
    for (const e of editors) {
      expect(e.label).toBeTruthy();
      expect(e.appPath).toMatch(/\.app$/);
    }
  });

  test("context menu shows 'Open With' submenu listing a detected editor", async () => {
    const editors = await window.evaluate(() => window.mediaWorkspace?.detectEditors?.());
    test.skip(!editors || editors.length === 0, "no known external editor installed on this machine");

    await window.locator("[data-gallery-item='true']").first().click({ button: "right" });
    const openWith = window.getByText("Open With", { exact: true });
    await expect(openWith).toBeVisible();
    // Hover to reveal the nested editor list; the first detected editor appears.
    await openWith.hover();
    await expect(window.getByText(editors[0].label, { exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
  });
});
