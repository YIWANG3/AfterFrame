// Embedded MCP server over plain HTTP — the agent-native surface.
// One app launch shared across the file (MCP calls are stateless against the
// same seeded catalog); import test runs last since it mutates the catalog.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;

async function waitForMcp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await mcpCall(port, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError || new Error("MCP server never came up");
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "mcp" });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("initialize negotiates protocol and ships instructions", async () => {
  const result = await waitForMcp(ctx.mcpPort);
  expect(result.serverInfo.name).toBe("afterframe");
  expect(result.protocolVersion).toBe("2025-06-18");
  expect(typeof result.instructions).toBe("string");
  expect(result.instructions).toContain("RESOURCE SET");
});

test("tools/list exposes the full tool surface", async () => {
  const { tools } = await mcpCall(ctx.mcpPort, "tools/list");
  const names = tools.map((t) => t.name);
  for (const expected of [
    "get_catalog_info", "search_assets", "get_asset", "view_assets", "show_in_app",
    "get_selection", "update_assets", "manage_collections", "annotate_assets",
    "repaint_asset", "delete_assets", "crop_assets", "export_assets",
    "import_directory", "get_job_status", "list_active_jobs", "cancel_job",
  ]) {
    expect(names).toContain(expected);
  }
  expect(tools.length).toBe(17);
});

test("search_assets returns the seeded catalog with thumbnail urls", async () => {
  const result = await mcpCall(ctx.mcpPort, "tools/call", {
    name: "search_assets",
    arguments: { limit: 50 },
  });
  expect(result.isError).toBe(false);
  const payload = JSON.parse(result.content[0].text);
  // 10 synthetic gradients + 3 real photographs + 1 sample video (seed-catalog.js).
  expect(payload.count).toBe(14);
  for (const asset of payload.assets) {
    expect(asset.asset_id).toBeTruthy();
    expect(asset.thumbnail_url).toContain(`http://127.0.0.1:${ctx.mcpPort}/assets/`);
  }
});

test("/assets serves preview bytes; unknown id is 404", async () => {
  const search = await mcpCall(ctx.mcpPort, "tools/call", {
    name: "search_assets",
    arguments: { limit: 1 },
  });
  const { assets } = JSON.parse(search.content[0].text);
  const ok = await fetch(assets[0].thumbnail_url);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toMatch(/^image\//);
  const bytes = await ok.arrayBuffer();
  expect(bytes.byteLength).toBeGreaterThan(500);

  const missing = await fetch(`http://127.0.0.1:${ctx.mcpPort}/assets/export_nope`);
  expect(missing.status).toBe(404);
});

test("cross-origin requests are rejected", async () => {
  const response = await fetch(`http://127.0.0.1:${ctx.mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  expect(response.status).toBe(403);
});

test("import_directory ingests a folder end to end", async () => {
  test.setTimeout(120000);
  // Two tiny valid JPEGs (1x1, generated once via sharp and inlined)
  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
    "base64",
  );
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-import-"));
  fs.writeFileSync(path.join(importDir, "mcp_e2e_a.jpg"), tinyJpeg);
  fs.writeFileSync(path.join(importDir, "mcp_e2e_b.jpg"), tinyJpeg);

  try {
    const started = await mcpCall(ctx.mcpPort, "tools/call", {
      name: "import_directory",
      arguments: { image_dirs: [importDir] },
    });
    expect(started.isError).toBe(false);
    let status = JSON.parse(started.content[0].text);

    // import_directory waits up to 25s itself; poll get_job_status if needed
    const deadline = Date.now() + 60000;
    while (!status.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await mcpCall(ctx.mcpPort, "tools/call", {
        name: "get_job_status",
        arguments: { job_id: status.job_id },
      });
      const job = JSON.parse(poll.content[0].text);
      status = { ...status, done: !job.running, status: job.status };
    }
    expect(status.status).toBe("succeeded");

    const search = await mcpCall(ctx.mcpPort, "tools/call", {
      name: "search_assets",
      arguments: { query: "mcp_e2e", limit: 10 },
    });
    const payload = JSON.parse(search.content[0].text);
    expect(payload.count).toBe(2);
  } finally {
    fs.rmSync(importDir, { recursive: true, force: true });
  }
});
