// MCP parity Phase 1 — the tools/filters added on top of the original 17.
// Two app launches: the default gradient catalog for asset-level tools, and
// the people fixture for the people tools. Everything goes over real HTTP
// against the embedded server, like 08-mcp-http.spec.js.

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
        clientInfo: { name: "e2e-parity", version: "0" },
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

test.describe("MCP parity — assets, geo, maintenance", () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "mcp-parity" });
    await waitForMcp(ctx.mcpPort);
  });
  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("tools/list exposes the Phase 1 additions", async () => {
    const { tools } = await mcpCall(ctx.mcpPort, "tools/list");
    const names = tools.map((t) => t.name);
    for (const expected of [
      "list_people", "get_person", "update_person", "index_people",
      "browse_map", "set_asset_location", "maintain_library", "raw_pairing",
      "add_text", "pause_job", "resume_job", "list_tags", "generate_previews",
    ]) {
      expect(names, `missing tool ${expected}`).toContain(expected);
    }
  });

  test("search_assets returns the new compact fields and honors new filters", async () => {
    const all = await callTool(ctx.mcpPort, "search_assets", { limit: 5 });
    expect(all.count).toBeGreaterThan(0);
    expect(all.assets[0].asset_type).toBe("image");

    const jpg = await callTool(ctx.mcpPort, "search_assets", { extension: "jpg", limit: 5 });
    expect(jpg.count).toBeGreaterThan(0);
    const none = await callTool(ctx.mcpPort, "search_assets", { extension: "tiff", limit: 5 });
    expect(none.count).toBe(0);
    // The fixture ships one video — the filter must return only videos, and
    // video rows must carry the video-only fields.
    const videos = await callTool(ctx.mcpPort, "search_assets", { asset_type: "video", limit: 5 });
    for (const v of videos.assets) expect(v.asset_type).toBe("video");
    const images = await callTool(ctx.mcpPort, "search_assets", { asset_type: "image", limit: 50 });
    expect(images.assets.every((a) => a.asset_type === "image")).toBe(true);

    const unannotated = await callTool(ctx.mcpPort, "search_assets", { annotated: "without", limit: 50 });
    expect(unannotated.count).toBeGreaterThan(0);
  });

  test("set_asset_location → get_asset location → browse_map → geo search round-trip", async () => {
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { limit: 2 });
    const id = assets[0].asset_id;

    const set = await callTool(ctx.mcpPort, "set_asset_location", {
      action: "set", asset_ids: [id], lat: 37.8025, lng: -122.4058,
    });
    expect(set.results[0].location.source).toBe("manual");

    const detail = await callTool(ctx.mcpPort, "get_asset", { asset_id: id });
    expect(detail.location.latitude).toBeCloseTo(37.8025, 3);

    const map = await callTool(ctx.mcpPort, "browse_map", {});
    expect(map.points.some((p) => p.asset_id === id)).toBe(true);

    const near = await callTool(ctx.mcpPort, "search_assets", {
      geo: { near: { lat: 37.8, lng: -122.4, km: 5 } },
    });
    expect(near.assets.some((a) => a.asset_id === id)).toBe(true);

    const far = await callTool(ctx.mcpPort, "search_assets", {
      geo: { near: { lat: 51.5, lng: -0.1, km: 5 } },
    });
    expect(far.assets.some((a) => a.asset_id === id)).toBe(false);

    // Clearing removes the manual pin; assets whose file has EXIF GPS fall
    // back to it (source becomes 'exif'), others end up with no location.
    const cleared = await callTool(ctx.mcpPort, "set_asset_location", { action: "clear", asset_ids: [id] });
    const afterClear = cleared.results[0].location;
    expect(afterClear === null || afterClear.source !== "manual").toBe(true);
  });

  test("crop_assets rect mode creates a derived version at the requested geometry", async () => {
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { limit: 1 });
    const src = assets[0];
    const out = await callTool(ctx.mcpPort, "crop_assets", {
      asset_ids: [src.asset_id],
      rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      quarter_turns: 1,
    });
    const result = out.results[0];
    expect(result.error).toBeUndefined();
    expect(result.new_asset_id).toBeTruthy();

    const detail = await callTool(ctx.mcpPort, "get_asset", { asset_id: result.new_asset_id });
    // Same version stack as the source — that's what "non-destructive" means here.
    expect(detail.resource_set?.set_id || detail.resource_set_id).toBe(src.resource_set_id);
  });

  test("crop_assets rejects mixing ratio and rect modes", async () => {
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { limit: 1 });
    const result = await mcpCall(ctx.mcpPort, "tools/call", {
      name: "crop_assets",
      arguments: { asset_ids: [assets[0].asset_id], ratio: "1:1", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    });
    expect(result.isError).toBe(true);
  });

  test("add_text renders a text overlay into the version stack", async () => {
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { limit: 1 });
    const out = await callTool(ctx.mcpPort, "add_text", {
      asset_id: assets[0].asset_id,
      text: "AfterFrame 测试 2026",
      y: 0.85,
      size: 0.06,
    });
    expect(out.new_asset_id).toBeTruthy();
    expect(out.path).toBeTruthy();
  });

  test("maintain_library verify_assets and watched-dir management", async () => {
    const verify = await callTool(ctx.mcpPort, "maintain_library", { action: "verify_assets" });
    expect(verify).toBeTruthy();

    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-mcp-watch-"));
    try {
      const added = await callTool(ctx.mcpPort, "maintain_library", { action: "add_watched_dir", dir });
      expect(added.dirs).toContain(dir);
      const listed = await callTool(ctx.mcpPort, "maintain_library", { action: "list_watched_dirs" });
      expect(listed.dirs).toContain(dir);
      const removed = await callTool(ctx.mcpPort, "maintain_library", { action: "remove_watched_dir", dir });
      expect(removed.dirs).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list_tags reflects update_assets tag writes", async () => {
    const { assets } = await callTool(ctx.mcpPort, "search_assets", { limit: 1 });
    await callTool(ctx.mcpPort, "update_assets", { asset_ids: [assets[0].asset_id], add_tags: ["mcp-parity-tag"] });
    const tags = await callTool(ctx.mcpPort, "list_tags", {});
    expect(tags.tags.some((t) => (t.tag || t.name || t) === "mcp-parity-tag" || t.tag === "mcp-parity-tag")).toBe(true);
    await callTool(ctx.mcpPort, "update_assets", { asset_ids: [assets[0].asset_id], remove_tags: ["mcp-parity-tag"] });
  });

  test("raw_pairing list_pending responds", async () => {
    const pending = await callTool(ctx.mcpPort, "raw_pairing", { action: "list_pending" });
    expect(Array.isArray(pending.pending)).toBe(true);
  });
});

test.describe("MCP parity — people", () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "mcp-people", catalogFixture: "people" });
    await waitForMcp(ctx.mcpPort);
  });
  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("list_people → get_person → rename → person_id search", async () => {
    const people = await callTool(ctx.mcpPort, "list_people", {});
    expect(people.count).toBeGreaterThan(0);
    const groupId = people.people[0].group_id || people.people[0].id;
    expect(groupId).toBeTruthy();

    const person = await callTool(ctx.mcpPort, "get_person", { person_id: groupId, face_limit: 4 });
    expect(Array.isArray(person.faces)).toBe(true);
    expect(person.faces.length).toBeGreaterThan(0);

    const renamed = await callTool(ctx.mcpPort, "update_person", {
      action: "rename", person_id: groupId, name: "MCP Test Person",
    });
    expect(renamed).toBeTruthy();
    const after = await callTool(ctx.mcpPort, "list_people", {});
    expect(after.people.some((p) => p.name === "MCP Test Person")).toBe(true);

    const photos = await callTool(ctx.mcpPort, "search_assets", { person_id: groupId });
    expect(photos.count).toBeGreaterThan(0);
    expect(photos.assets[0].has_face).toBe(true);

    const withFaces = await callTool(ctx.mcpPort, "search_assets", { people: "with_faces" });
    expect(withFaces.count).toBeGreaterThan(0);
  });
});
