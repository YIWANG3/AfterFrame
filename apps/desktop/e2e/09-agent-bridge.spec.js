// Agent ↔ UI bridges: the selection mirror (UI click → MCP get_selection),
// the reveal flow (MCP show_in_app → gallery selection + ring), and the
// catalog-changed broadcast (MCP update_assets → toast + refreshed view).
// One app launch shared across the file; tests are order-dependent only in
// that they all act on the same seeded 10-image catalog.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, waitForMcp, galleryCards } = require("./helpers/app");

let ctx;

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "bridge" });
  await waitForMcp(ctx.mcpPort);
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("clicking a card in the UI is visible to MCP get_selection", async () => {
  const card = galleryCards(ctx.window).first();
  await card.click();
  await expect(ctx.window.locator("[data-selected='true']").first()).toBeVisible();

  // Selection mirror is an IPC hop — poll briefly for it to land
  await expect(async () => {
    const selection = await callTool("get_selection");
    expect(selection.count).toBe(1);
    expect(selection.assets[0].asset_id).toMatch(/^image_/);
    expect(selection.assets[0].image_path).toBeTruthy();
  }).toPass({ timeout: 5_000 });
});

test("MCP show_in_app selects and reveals assets in the gallery", async () => {
  const { assets } = await callTool("search_assets", { limit: 3, sort: "name-asc" });
  const targets = assets.slice(1, 3).map((a) => a.asset_id); // not the already-selected first card

  const result = await callTool("show_in_app", { asset_ids: targets });
  expect([...result.found].sort()).toEqual([...targets].sort());
  expect(result.missing).toEqual([]);

  // Both cards carry the selection ring, and the reveal toast appeared
  await expect(ctx.window.locator("[data-selected='true']")).toHaveCount(2, { timeout: 5_000 });
  await expect(ctx.window.getByText(/Selected 2 photos/i)).toBeVisible({ timeout: 5_000 });

  // Roundtrip: the agent-made selection is now the user selection
  await expect(async () => {
    const selection = await callTool("get_selection");
    expect(selection.assets.map((a) => a.asset_id).sort()).toEqual([...targets].sort());
  }).toPass({ timeout: 5_000 });
});

test("MCP show_in_app reports ids that don't exist", async () => {
  const { assets } = await callTool("search_assets", { limit: 1 });
  const result = await callTool("show_in_app", { asset_ids: [assets[0].asset_id, "image_does_not_exist"] });
  expect(result.found).toEqual([assets[0].asset_id]);
  expect(result.missing).toEqual(["image_does_not_exist"]);
});

test("MCP update_assets refreshes the UI and raises the agent toast", async () => {
  const { assets } = await callTool("search_assets", { limit: 1, sort: "name-asc" });
  const target = assets[0].asset_id;

  const result = await callTool("update_assets", { asset_ids: [target], rating: 4, add_tags: ["e2e-agent"] });
  expect(result.updated).toBe(1);
  expect(result.errors).toBeUndefined();

  // catalog-changed broadcast → toast from the agent-change watcher
  await expect(ctx.window.getByText(/Updated 1 item in the library/i)).toBeVisible({ timeout: 5_000 });

  // The write is queryable back through MCP (tag filter + rating)
  const verify = await callTool("search_assets", { tag: "e2e-agent" });
  expect(verify.count).toBe(1);
  expect(verify.assets[0].asset_id).toBe(target);
  expect(verify.assets[0].rating).toBe(4);
});

test("in Chinese the agent toasts are in Chinese too", async () => {
  // They were hard-coded English while the rest of the app followed the language.
  const toasts = ctx.window.getByTestId("toast-card");
  const english = toasts.filter({ hasText: /Selected|Updated|Collections updated|Agent/ });
  await expect(english).toHaveCount(0, { timeout: 15_000 }); // the earlier tests' toasts time out
  await ctx.window.evaluate(() => window.__afterframeTest.setLocale("zh-CN"));
  await expect(ctx.window.getByRole("button", { name: "全部素材" })).toBeVisible({ timeout: 5_000 });

  const { assets } = await callTool("search_assets", { limit: 2, sort: "name-asc" });
  await callTool("show_in_app", { asset_ids: [assets[0].asset_id, assets[1].asset_id, "image_does_not_exist"] });
  await expect(toasts.filter({ hasText: "已选中 2 张照片，1 张没找到。" })).toBeVisible({ timeout: 5_000 });
  await expect(toasts.filter({ hasText: "已选中 2 张照片，1 张没找到。" })).toContainText("智能体");

  await callTool("update_assets", { asset_ids: [assets[0].asset_id], add_tags: ["e2e-agent-zh"] });
  await expect(toasts.filter({ hasText: "已更新图库中的 1 个素材。" })).toBeVisible({ timeout: 5_000 });

  await callTool("manage_collections", { action: "create", name: "智能体建的合集" });
  await expect(toasts.filter({ hasText: "合集已更新。" })).toBeVisible({ timeout: 5_000 });

  await expect(english).toHaveCount(0);
});
