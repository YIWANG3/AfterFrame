// Agent ↔ UI bridges: the selection mirror (UI click → MCP get_selection),
// the reveal flow (MCP show_in_app → gallery selection + ring), and the
// catalog-changed broadcast (MCP update_assets → toast + refreshed view).
// One app launch shared across the file; tests are order-dependent only in
// that they all act on the same seeded 10-image catalog.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function waitForMcp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await mcpCall(ctx.mcpPort, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError;
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "bridge" });
  await waitForMcp();
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("clicking a card in the UI is visible to MCP get_selection", async () => {
  const card = ctx.window.locator("[data-gallery-item='true']").first();
  await card.click();
  await expect(ctx.window.locator("[data-selected='true']").first()).toBeVisible();

  // Selection mirror is an IPC hop — poll briefly for it to land
  await expect(async () => {
    const selection = await callTool("get_selection");
    expect(selection.count).toBe(1);
    expect(selection.assets[0].asset_id).toMatch(/^export_/);
    expect(selection.assets[0].export_path).toBeTruthy();
  }).toPass({ timeout: 5_000 });
});

test("MCP show_in_app selects and reveals assets in the gallery", async () => {
  const { assets } = await callTool("search_assets", { limit: 3, sort: "name-asc" });
  const targets = assets.slice(1, 3).map((a) => a.asset_id); // not the already-selected first card

  const result = await callTool("show_in_app", { asset_ids: targets });
  expect(result.found).toEqual(targets);
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
  const result = await callTool("show_in_app", { asset_ids: [assets[0].asset_id, "export_does_not_exist"] });
  expect(result.found).toEqual([assets[0].asset_id]);
  expect(result.missing).toEqual(["export_does_not_exist"]);
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
