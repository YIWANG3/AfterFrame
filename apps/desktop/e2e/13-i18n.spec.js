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
  // Same path the language <select> fires (i18n.changeLanguage + persist), via
  // the test backdoor — driving a native select that re-renders is racy.
  await ctx.window.evaluate(() => window.__afterframeTest.setLocale("zh-CN"));
  // The always-present sidebar browse labels flip live, no reload.
  await expect(ctx.window.getByRole("button", { name: "全部素材" })).toBeVisible({ timeout: 5_000 });
  await expect(ctx.window.getByRole("button", { name: "最近添加" })).toBeVisible();
});

test("switching to 中文 rebuilds the native menu", async () => {
  const labels = await ctx.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.map((i) => i.label),
  );
  expect(labels).toContain("文件");
  expect(labels).toContain("编辑");
});

test("the Edit submenu labels follow the app language", async () => {
  const editItems = await ctx.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label === "编辑");
    return edit?.submenu?.items.map((i) => i.label).filter(Boolean);
  });
  expect(editItems).toContain("撤销");
  expect(editItems).toContain("全选");
});
