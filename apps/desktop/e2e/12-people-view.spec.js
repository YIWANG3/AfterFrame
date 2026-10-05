// The candidate page remains useful before any groups exist: it should be
// reachable from the normal sidebar and explain the next local-only step.
// Group contents are covered by the sidecar persistence/query tests because
// they depend on a real Core ML model and face embeddings.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, lacks } = require("./helpers/app");

test.skip(lacks("people"), "people recognition is macOS-only for now (electron/capabilities.js)");

test.describe("without a face model", () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "people-view" });
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("People sidebar opens the local people wall", async () => {
    const people = ctx.window.getByRole("button", { name: "People" });
    await expect(people).toHaveCount(1);
    await people.click();
    await expect(ctx.window.getByRole("heading", { name: "People" })).toBeVisible();
    // A build without the bundled model can't scan; the empty state points to
    // Settings instead of offering a download.
    await expect(ctx.window.getByText("No face model in this build")).toBeVisible();
    await expect(ctx.window.getByRole("button", { name: "Scan faces" }).first()).toBeDisabled();
    await expect(ctx.window.getByText(/download/i)).toHaveCount(0);
  });
});

test.describe("with the built-in face model", () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "people-view-bundled", peopleModel: "stub" });
    await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("People is ready to scan with nothing to download", async () => {
    await ctx.window.getByRole("button", { name: "People" }).click();
    await expect(ctx.window.getByText("No people yet")).toBeVisible();
    await expect(ctx.window.getByRole("button", { name: "Scan faces" }).first()).toBeEnabled();
  });

  test("Settings shows the built-in model as active and not removable", async () => {
    await ctx.window.keyboard.press("Meta+,");
    await ctx.window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "People" }).click();
    await expect(ctx.window.getByText(/Built into AfterFrame · 125 MB/)).toBeVisible();
    await expect(ctx.window.getByRole("button", { name: /Download/ })).toHaveCount(0);
    await expect(ctx.window.getByTitle("Remove model")).toHaveCount(0);
    const autoIndex = ctx.window.getByText("Analyze faces after import", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]").getByRole("switch");
    await expect(autoIndex).toBeEnabled();
  });
});
