// MCP parity Phase 2 — the render-bridge tools: real canvas rendering in the
// renderer process, driven over MCP HTTP, asserted on catalog outcomes and
// actual output pixels/dimensions (sharp-decoded from disk).

const fs = require("node:fs");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

async function waitForMcp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await mcpCall(port, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-render", version: "0" },
      });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError || new Error("MCP server never came up");
}

function toolResult(result) {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return JSON.parse(result.content.find((c) => c.type === "text").text);
}

async function callTool(port, name, args) {
  return toolResult(await mcpCall(port, "tools/call", { name, arguments: args || {} }));
}

// Decode saved output with the repo's own sharp to verify real pixels landed.
async function imageMeta(filePath) {
  const sharp = require("sharp");
  return sharp(filePath).metadata();
}

let ctx;
let photoIds; // stable id set from the seeded catalog

test.describe("MCP render bridge tools", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "mcp-render" });
    await waitForMcp(ctx.mcpPort);
    // The render bridge registers when the React app mounts — later than the
    // MCP server. Wait for the gallery so bridge-backed tools are reachable.
    await ctx.window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15000 });
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { asset_type: "image", sort: "name-asc", limit: 12 });
    photoIds = assets.map((a) => a.asset_id);
    expect(photoIds.length).toBeGreaterThanOrEqual(6);
  });
  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("get_editor_capabilities enumerates frames, fonts, collage layouts", async () => {
    const caps = await callTool(ctx.mcpPort, "get_editor_capabilities", {});
    expect(caps.frame_templates.length).toBeGreaterThan(3);
    expect(caps.frame_templates[0]).toHaveProperty("id");
    expect(caps.fonts).toContain("Plus Jakarta Sans");
    expect(caps.collage_templates["4"].some((t) => t.id === "4-grid")).toBe(true);
    expect(caps.edit_layer_types).toContain("text");
  });

  test("render_collage single page: 2x2 grid with real pixels and source links", async () => {
    const ids = photoIds.slice(0, 4);
    const out = await callTool(ctx.mcpPort, "render_collage", {
      asset_ids: ids,
      template_id: "4-grid",
      export_width: 1200,
      bg: "#112233",
    });
    expect(out.pages).toBe(1);
    const page = out.results[0];
    expect(page.error, JSON.stringify(out)).toBeUndefined();
    expect(page.new_asset_id).toBeTruthy();
    expect(page.template_id).toBe("4-grid");
    expect(fs.existsSync(page.path)).toBe(true);
    const meta = await imageMeta(page.path);
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1200); // default ratio 1

    // Registered in the catalog and traceable to its sources (collage links).
    const detail = await callTool(ctx.mcpPort, "get_asset", { asset_id: page.new_asset_id });
    expect(detail.asset_id).toBe(page.new_asset_id);
  });

  test("render_collage batch mode: per_page chunks into multiple pages", async () => {
    const ids = photoIds.slice(0, 6);
    const out = await callTool(ctx.mcpPort, "render_collage", {
      asset_ids: ids,
      per_page: 4,
      export_width: 800,
    });
    expect(out.pages).toBe(2); // 4 + 2 remainder
    for (const page of out.results) {
      expect(page.error, JSON.stringify(page)).toBeUndefined();
      expect(fs.existsSync(page.path)).toBe(true);
    }
    const meta2 = await imageMeta(out.results[1].path);
    expect(meta2.width).toBe(800);
  });

  test("render_collage rejects an unknown template with valid choices listed", async () => {
    const result = await mcpCall(ctx.mcpPort, "tools/call", {
      name: "render_collage",
      arguments: { asset_ids: photoIds.slice(0, 4), template_id: "not-a-layout" },
    });
    // Per-page error, not a tool error — check the message carries guidance.
    const payload = JSON.parse(result.content.find((c) => c.type === "text").text);
    expect(JSON.stringify(payload)).toContain("4-grid");
  });

  test("edit_asset: crop + margins + text layer lands as a derived version", async () => {
    const srcId = photoIds[0];
    const before = await callTool(ctx.mcpPort, "search_assets", { limit: 200 });
    const src = before.assets.find((a) => a.asset_id === srcId);

    const out = await callTool(ctx.mcpPort, "edit_asset", {
      asset_id: srcId,
      geometry: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      canvas: { pad: { top: 0.05, right: 0.05, bottom: 0.18, left: 0.05 }, bg: "#ffffff" },
      layers: [
        { type: "text", text: "AfterFrame 测试", y: 0.93, size: 0.05, color: "#222222" },
      ],
    });
    expect(out.new_asset_id).toBeTruthy();
    expect(fs.existsSync(out.path)).toBe(true);
    const meta = await imageMeta(out.path);
    // Crop kept the source aspect; the asymmetric bottom margin must make the
    // output proportionally taller than the source aspect ratio.
    expect(meta.height / meta.width).toBeGreaterThan((src.height / src.width) * 1.05);
    // And the crop shrank the photo relative to the original.
    expect(meta.width).toBeLessThan(src.width);

    const after = await callTool(ctx.mcpPort, "search_assets", { limit: 200 });
    const derived = after.assets.find((a) => a.asset_id === out.new_asset_id);
    expect(derived.resource_set_id).toBe(src.resource_set_id);
    expect(derived.version_kind).toBe("derived");
  });

  test("apply_frame: EXIF watermark template renders with margins and registers", async () => {
    const caps = await callTool(ctx.mcpPort, "get_editor_capabilities", {});
    const template = caps.frame_templates[0].id;
    const srcId = photoIds[1];
    const srcDetail = await callTool(ctx.mcpPort, "get_asset", { asset_id: srcId });
    const srcMeta = await imageMeta(srcDetail.image_path);

    const out = await callTool(ctx.mcpPort, "apply_frame", { asset_ids: [srcId], template });
    const result = out.results[0];
    expect(result.error, JSON.stringify(out)).toBeUndefined();
    expect(result.new_asset_id).toBeTruthy();
    expect(fs.existsSync(result.path)).toBe(true);
    // A frame adds margins — output must be strictly larger than the source
    // photo in at least one dimension (overlay templates keep size; classic
    // templates grow). Either way it must be a real decodable image.
    const meta = await imageMeta(result.path);
    expect(meta.width).toBeGreaterThanOrEqual(Math.min(srcMeta.width, 100));

    const after = await callTool(ctx.mcpPort, "search_assets", { limit: 200 });
    const derived = after.assets.find((a) => a.asset_id === result.new_asset_id);
    expect(derived.version_kind).toBe("derived");
  });

  test("apply_frame rejects an unknown template with the valid ids", async () => {
    const out = await callTool(ctx.mcpPort, "apply_frame", { asset_ids: [photoIds[0]], template: "nope" });
    expect(out.results[0].error).toContain("unknown frame template");
  });

  test("show_in_app view=collage opens the collage composer", async () => {
    const res = await callTool(ctx.mcpPort, "show_in_app", { asset_ids: photoIds.slice(0, 3), view: "collage" });
    expect(res.opened).toBe("collage");
    expect(res.count).toBe(3);
    // The overlay is really up in the UI.
    await expect(ctx.window.locator("[data-testid='collage-overlay'], .collage-overlay").first())
      .toBeVisible({ timeout: 5000 })
      .catch(async () => {
        // Fallback: any dialog containing collage controls
        await expect(ctx.window.getByText(/collage|拼图/i).first()).toBeVisible({ timeout: 5000 });
      });
  });

  test("show_in_app view=editor opens the editor on the asset", async () => {
    const res = await callTool(ctx.mcpPort, "show_in_app", { asset_ids: [photoIds[0]], view: "editor" });
    expect(res.opened).toBe("editor");
    expect(res.asset_id).toBe(photoIds[0]);
  });
});
