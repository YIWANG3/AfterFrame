// Settings overlay: all four tabs switch and render their real content,
// Escape closes back to the gallery.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "settings" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("opens from the sidebar and shows the AI Annotation tab by default", async () => {
  await ctx.window.getByRole("button", { name: "Settings" }).click();
  await expect(ctx.window.getByText("Auto-annotation providers")).toBeVisible({ timeout: 5_000 });
  await ctx.window.getByRole("button", { name: "Add new provider" }).click();
  await expect(ctx.window.getByText("New Provider", { exact: true })).toBeVisible();
  await ctx.window.getByRole("button", { name: "Cancel" }).click();
});

test("General tab — theme selector flips the applied theme live", async () => {
  await ctx.window.getByRole("button", { name: "General" }).click();
  await expect(ctx.window.getByText("Appearance")).toBeVisible();
  // Two selects on this tab: language (0), theme (1).
  const themeSelect = ctx.window.getByRole("combobox").nth(1);
  await themeSelect.selectOption("light");
  await expect
    .poll(() => ctx.window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  // Revert so the rest of the suite / gallery see the default dark theme.
  await themeSelect.selectOption("dark");
  await expect
    .poll(() => ctx.window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
});

test("AI Repaint tab renders the provider list", async () => {
  await ctx.window.getByRole("button", { name: "AI Repaint" }).click();
  // Fresh test profile has no providers configured — the empty-state callout
  await expect(ctx.window.getByText(/No repaint provider configured/i)).toBeVisible({ timeout: 5_000 });
  await ctx.window.getByRole("button", { name: "Add provider" }).click();
  await expect(ctx.window.getByText("New Provider", { exact: true })).toBeVisible();
  await ctx.window.getByRole("button", { name: "Cancel" }).click();
});

test("People tab renders local-model onboarding", async () => {
  // This test also runs independently via --grep, where the earlier test that
  // opens the shared Settings overlay is intentionally skipped.
  if (!await ctx.window.getByRole("button", { name: "General" }).isVisible()) {
    await ctx.window.getByRole("button", { name: "Settings" }).click();
  }
  // Scope to the settings tab list — the app sidebar also has a "People" button.
  await ctx.window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "People" }).click();
  await expect(ctx.window.getByText("Face model", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("No compatible face model is installed yet.")).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: /Download ArcFace R100/ })).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "Choose model…" })).toBeVisible();
  await expect(ctx.window.getByText("Index your library")).toBeVisible();
});

test("Library tab renders catalog/cache groups + HD preview toggle", async () => {
  await ctx.window.getByRole("button", { name: "Library" }).click();
  await expect(ctx.window.getByText("Current catalog", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("Current Catalog", { exact: true }).first()).toBeVisible();
  // Catalog contents reflect the seeded fixture: 13 images + 1 video = 14.
  await expect(ctx.window.getByText("14 assets · 13 photos · 1 videos")).toBeVisible();
  await expect(ctx.window.getByText("Cache & storage")).toBeVisible();
  await expect(ctx.window.getByText("Watched directories", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("No watched directories in this Catalog.")).toBeVisible();
  // HD previews are opt-in: the toggle exists and defaults off.
  const hdToggle = ctx.window.getByRole("switch").first();
  await expect(ctx.window.getByText("Generate HD previews (2000px)")).toBeVisible();
  await expect(hdToggle).toHaveAttribute("aria-checked", "false");
});

test("About tab renders the product blurb", async () => {
  await ctx.window.getByRole("button", { name: "About" }).click();
  await expect(ctx.window.getByText(/local-first photo workspace/i)).toBeVisible();
});

test("Escape closes settings and restores the gallery", async () => {
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByText("Auto-annotation providers")).toHaveCount(0);
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible();
});
