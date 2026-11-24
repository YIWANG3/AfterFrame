// i18n (P0): switching the language in Settings ▸ General flips both the
// renderer UI and the native (main-process) menu, live.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "i18n" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("defaults to English; menu is English", async () => {
  await ctx.window.keyboard.press("ControlOrMeta+,");
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

test("the synced folders group says 图库, not Catalog", async () => {
  // Settings is still open from the first test.
  const settings = ctx.window.locator("[data-layer='settings']");
  await settings.getByRole("button", { name: "图库", exact: true }).click();
  await expect(settings.getByText("自动同步的文件夹", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(settings.getByText("当前图库还没有自动同步的文件夹。", { exact: true })).toBeVisible();
  await expect(settings.getByText(/^仅属于当前图库。/)).toBeVisible();
  await expect(settings.getByText(/Catalog|监控/)).toHaveCount(0);
});

test("the collage cell panel's Center and Reset are in 中文 too", async () => {
  // They were hard-coded English while the rest of the cell panel followed the app language.
  await ctx.window.keyboard.press("Escape"); // the Settings window from the first test
  await expect(ctx.window.locator("[data-layer='settings']")).toHaveCount(0);
  const cards = galleryCards(ctx.window);
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Shift"] });
  await cards.nth(0).click({ button: "right" });
  await ctx.window.getByText(/^拼图$/).click();
  const canvas = ctx.window.getByTestId("collage-canvas");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * 0.25, y: box.height * 0.5 } });
  await expect(ctx.window.getByRole("button", { name: "居中", exact: true })).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "重置", exact: true })).toBeVisible();
  await expect(ctx.window.getByRole("button", { name: "Center", exact: true })).toHaveCount(0);
});
