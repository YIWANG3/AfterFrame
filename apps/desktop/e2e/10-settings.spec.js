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
});

test("AI Repaint tab renders the provider list", async () => {
  await ctx.window.getByRole("button", { name: "AI Repaint" }).click();
  // Fresh test profile has no providers configured — the empty-state callout
  await expect(ctx.window.getByText(/No repaint provider configured/i)).toBeVisible({ timeout: 5_000 });
});

test("Library tab renders catalog/cache groups + HD preview toggle", async () => {
  await ctx.window.getByRole("button", { name: "Library" }).click();
  await expect(ctx.window.getByText("Current catalog")).toBeVisible();
  await expect(ctx.window.getByText("Cache & storage")).toBeVisible();
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
