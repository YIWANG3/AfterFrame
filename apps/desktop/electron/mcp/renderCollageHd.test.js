// A RAW's HD preview isn't made at import any more, and the renderer can't
// decode a RAW, so render_collage draws a RAW cell from its preview. It must
// make the missing HD ones first or those cells are upscaled from the 512px
// thumbnail. Driven through the real JSON-RPC endpoint with a fake sidecar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpServer } = require("./server");

function fakeCatalog(assets) {
  const hd = new Map();
  const ensured = [];
  const commands = {
    async assetDetail({ assetId }) {
      const asset = assets[assetId];
      if (!asset) throw new Error(`unknown export asset ${assetId}`);
      return { asset_id: assetId, ...asset, image_preview_hd_path: asset.image_preview_hd_path || hd.get(assetId) || null };
    },
    async ensureHdPreviews(paths) {
      ensured.push(paths);
      for (const [id, asset] of Object.entries(assets)) {
        if (paths.includes(asset.image_path) && !asset.unreadable) hd.set(id, `/catalog/previews-hd/${id}.jpg`);
      }
      return { generated: paths.length };
    },
  };
  return { commands, ensured };
}

async function renderCollage(assets, assetIds, extra = {}) {
  const catalogPath = fs.mkdtempSync(path.join(os.tmpdir(), "af-mcp-collage-"));
  const { commands, ensured } = fakeCatalog(assets);
  const rendered = [];
  const mcp = createMcpServer({
    port: 0,
    getCatalogState: () => ({ currentCatalogPath: catalogPath, catalogHasDb: () => true }),
    commands,
    async askRenderer(kind, payload) {
      rendered.push(payload.files);
      return { asset: { asset_id: "collage_1" }, template_id: "t", width: 1, height: 1, saved_path: payload.savePath };
    },
  });
  await mcp.start();
  try {
    const { port } = mcp.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "render_collage", arguments: { asset_ids: assetIds, ...extra } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, false, body.result.content?.[0]?.text);
    return { ensured, rendered };
  } finally {
    await new Promise((resolve) => mcp.server.close(resolve));
    fs.rmSync(catalogPath, { recursive: true, force: true });
  }
}

test("render_collage makes the missing RAW HD previews and draws RAW cells from them", async () => {
  const { ensured, rendered } = await renderCollage({
    raw1: { asset_type: "raw", image_path: "/photos/a.CR3", image_preview_path: "/catalog/previews/raw1.jpg" },
    raw2: { asset_type: "raw", image_path: "/photos/b.ARW", image_preview_path: "/catalog/previews/raw2.jpg", image_preview_hd_path: "/catalog/previews-hd/raw2-old.jpg" },
    raw3: { asset_type: "raw", image_path: "/photos/c.3FR", image_preview_path: "/catalog/previews/raw3.jpg", unreadable: true },
    jpg: { asset_type: "image", image_path: "/photos/d.jpg", image_preview_path: "/catalog/previews/jpg.jpg" },
  }, ["raw1", "raw2", "raw3", "jpg"]);

  // One call for the RAWs without an HD; RAWs with one and images are left alone.
  assert.deepEqual(ensured, [["/photos/a.CR3", "/photos/c.3FR"]]);
  assert.deepEqual(rendered[0].map((f) => [f.assetId, f.previewPath]), [
    ["raw1", "/catalog/previews-hd/raw1.jpg"],
    ["raw2", "/catalog/previews-hd/raw2-old.jpg"],
    // No HD could be made: the thumbnail rather than failing the render.
    ["raw3", "/catalog/previews/raw3.jpg"],
    ["jpg", "/catalog/previews/jpg.jpg"],
  ]);
});

test("render_collage asks for RAW HD previews a few per sidecar call", async () => {
  const assets = {};
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    assets[`r${i}`] = { asset_type: "raw", image_path: `/photos/r${i}.NEF`, image_preview_path: `/catalog/previews/r${i}.jpg` };
    ids.push(`r${i}`);
  }
  const { ensured, rendered } = await renderCollage(assets, ids, { per_page: 5 });
  assert.deepEqual(ensured.map((paths) => paths.length), [8, 2]);
  assert.ok(rendered.flat().every((f) => f.previewPath === `/catalog/previews-hd/${f.assetId}.jpg`));
});
