// The user chooses which facets sit on the filter bar. A hidden facet that
// is filtering still shows; the choice survives a relaunch.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall, collectCoverage } = require("./helpers/app");

let ctx;
const bar = () => ctx.window.locator("[data-filter-bar]");
const chip = (name) => bar().getByRole("button", { name, exact: true });
const slot = (id) => ctx.window.locator(`[data-facet-slot="${id}"]`);
const openChooser = () => bar().getByRole("button", { name: "Add filter", exact: true }).click();

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "custom-filter-bar" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("untick a facet and it leaves the bar; tick it back", async () => {
  await expect(chip("Camera")).toBeVisible();
  await expect(chip("Format")).toBeVisible();
  await openChooser();
  await expect(slot("camera")).toHaveAttribute("aria-checked", "true");
  await slot("camera").click();
  await slot("extension").click();
  await ctx.window.keyboard.press("Escape");
  await expect(chip("Camera")).toHaveCount(0);
  await expect(chip("Format")).toHaveCount(0);
  await expect(chip("Lens")).toBeVisible();

  await openChooser();
  await slot("camera").click();
  await ctx.window.keyboard.press("Escape");
  await expect(chip("Camera")).toBeVisible();
  await expect(chip("Format")).toHaveCount(0);
});

test("a hidden facet that is filtering shows anyway", async () => {
  const tool = async (name, args) => JSON.parse((await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args })).content[0].text);
  await tool("manage_collections", { action: "create", name: "JPEGs", rules: { extension: "jpg" } });
  const row = ctx.window.locator("[data-smart-collection]").filter({ hasText: "JPEGs" });
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByTitle("Edit conditions").click();
  // The rule is on the bar although Format is unticked (as saved: "jpg").
  const rule = bar().getByRole("button", { name: /^jpg$/i });
  await expect(rule).toBeVisible();
  await bar().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rule).toHaveCount(0);
  await expect(chip("Format")).toHaveCount(0);
});

test("the choice survives a relaunch", async () => {
  await collectCoverage(ctx.app); // the restart path bypasses closeApp
  await ctx.app.close();
  ctx = { ...ctx, ...(await launchApp({ testName: "custom-filter-bar", reuseUserDataDir: ctx.userDataDir, keepCatalog: true })) };
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  await ctx.window.getByRole("button", { name: "Filters" }).click();
  await expect(chip("Camera")).toBeVisible();
  await expect(chip("Format")).toHaveCount(0);
});
