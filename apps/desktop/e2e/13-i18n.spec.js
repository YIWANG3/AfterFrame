// i18n (P0): switching the language in Settings ▸ General flips both the
// renderer UI and the native (main-process) menu, live.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "i18n" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("defaults to English; menu is English", async () => {
  await ctx.window.getByRole("button", { name: "Settings" }).click();
  await ctx.window.getByRole("button", { name: "General" }).click();
  await expect(ctx.window.getByText("Interface language. Takes effect immediately.")).toBeVisible({ timeout: 5_000 });

  const fileLabel = await ctx.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.map((i) => i.label).find((l) => /^File$|^文件$/.test(l)),
  );
  expect(fileLabel).toBe("File");
});

test("switching to 中文 flips the renderer UI live", async () => {
  await ctx.window.locator("select").selectOption("zh-CN");
  // Tab labels re-render through react-i18next without a reload.
  await expect(ctx.window.getByRole("button", { name: "通用" })).toBeVisible({ timeout: 5_000 });
  await expect(ctx.window.getByRole("button", { name: "AI 标注" })).toBeVisible();
});

test("switching to 中文 rebuilds the native menu", async () => {
  const fileLabel = await ctx.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.map((i) => i.label).find((l) => /^File$|^文件$/.test(l)),
  );
  expect(fileLabel).toBe("文件");
});
