// Embedded MCP server — lets external AI agents (Claude Code, etc.) control
// AfterFrame while it runs. Speaks MCP streamable-HTTP (JSON-RPC over POST)
// on 127.0.0.1 only, plus a /assets/{id} endpoint that serves preview bytes
// so agents and chat UIs can actually see the images instead of file paths.
// Design doc: docs/agent-native-mcp.md. The tools themselves live in
// ./tools/*.js, one file per domain; this file is the transport, the
// preview-path cache behind /assets/{id}, and the assembly.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { requireCatalogPath } = require("../ipc/guard");
const { createTools } = require("./tools");

const DEFAULT_PORT = 41706;
// The app's version (package.json; app.getVersion() reads the same field).
const SERVER_INFO = { name: "afterframe", version: require("../../package.json").version };

// Injected into every connecting agent's context via the initialize response —
// the crash course in AfterFrame's domain model that tool descriptions alone
// can't carry.
const SERVER_INSTRUCTIONS = `AfterFrame is a desktop photo library the user is running right now. You are operating on their real catalog.

Domain model:
- ASSET: one photo or video (an export/processed file, optionally paired with its RAW source file). Identified by asset_id; asset_type tells photos and videos apart.
- RESOURCE SET (version stack): a family of versions of the same photo — original, crops, text overlays, AI repaints. crop_assets/add_text add versions; originals are never modified.
- COLLECTION: a folder is a manual album. A SMART collection is a saved filter (the same conditions search_assets takes) that fills itself and stays current; create and edit them with manage_collections. Photos cannot be added to a smart collection by hand.
- PERSON: a face group produced by the offline face recognizer (list_people). person_id filters search_assets; update_person renames/merges/hides groups.
- LOCATION: one effective location per asset, priority manual > EXIF GPS > AI-resolved place guess. browse_map lists points; search_assets geo filters by area; set_asset_location pins manually.
- JOB: long-running background work (import / annotation / previews / people indexing). Jobs appear in the app's JobDock where the user can watch, pause and cancel them.

Working style:
- "These photos" / "this one" → call get_selection (the user's live selection in the app window).
- Creative output (collages, frames/EXIF watermarks, text/sticker composites) → render_collage / apply_frame / edit_asset render with the app's own pipeline; check get_editor_capabilities for valid template/font ids first. Results land in the catalog like any user export. show_in_app with view "editor"/"collage" hands unfinished work to the user.
- Locating photos by description → search_assets free-text matches filename, camera, AI caption, tags, OCR. If results are ambiguous, view_assets and look. Annotation coverage determines text-search quality — annotate_assets fills it.
- After finding or producing images for the user, prefer show_in_app over describing them: the app window is the best viewer. Use view_assets when YOU need to see them.
- Destructive-ish operations: crops/exports are non-destructive. delete_assets removes catalog records but never touches the original files on disk — still, confirm with the user before deleting unless they explicitly asked. Ratings/tags/collections are cheap to write and easy for the user to revert.
- Long jobs return a job_id immediately — poll get_job_status rather than blocking, and tell the user the job is visible in the app.

Paths: thumbnail_url fields are localhost HTTP URLs servable only on this machine.`;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 2 * 1024 * 1024; // JSON-RPC requests are tiny; cap abuse
// RAW HD previews made per sidecar call when a tool needs them. Each call has
// the resident's 30 s timeout; a few at a time finish inside it.
const HD_ENSURE_CHUNK = 8;

// asset_id -> { preview, previewHd } absolute paths, filled by search results
// so /assets/{id} usually serves without spawning the sidecar again.
//
// MUST be cleared on every catalog switch: asset_id is a stable hash of
// fingerprint + path (metadata.py stable_asset_id), so the same photo carries
// the same id in two different catalogs — a stale entry would serve the OTHER
// library's preview file. main.js calls clearPreviewCache() from
// switchCatalogTo; keep it in the returned API.
const previewPathCache = new Map();

function rememberPreview(assetId, preview, previewHd) {
  if (!assetId) return;
  const prior = previewPathCache.get(assetId) || {};
  previewPathCache.set(assetId, {
    preview: preview || prior.preview || null,
    previewHd: previewHd || prior.previewHd || null,
  });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  return "image/jpeg";
}

function createMcpServer(deps) {
  const {
    getCatalogState,
    commands,
    startImportTask,
    formatJobStatus,
    registerRoots,
    sharp,
    port = DEFAULT_PORT,
  } = deps;

  const requireCatalog = () => requireCatalogPath(getCatalogState);

  async function resolvePreviewPaths(assetId) {
    const cached = previewPathCache.get(assetId);
    if (cached && (cached.preview || cached.previewHd)) return cached;
    let detail;
    try {
      detail = await commands.assetDetail({ assetId });
    } catch (error) {
      // Unknown asset id is a lookup miss (→ 404 at the endpoint), not a
      // server fault — anything else propagates.
      if (!/unknown export asset/i.test(error.message)) throw error;
      return { preview: null, previewHd: null };
    }
    rememberPreview(assetId, detail?.image_preview_path, detail?.image_preview_hd_path);
    return previewPathCache.get(assetId) || { preview: null, previewHd: null };
  }

  // A RAW's HD preview is made on demand (not at import), so asking for HD
  // makes it first rather than answering with the 512px thumbnail.
  async function resolveHdPreviewPaths(assetId) {
    const paths = await resolvePreviewPaths(assetId);
    if (paths.previewHd) return paths;
    const detail = await commands.assetDetail({ assetId }).catch(() => null);
    if (detail?.asset_type !== "raw" || !detail.image_path) return paths;
    await commands.ensureHdPreviews([detail.image_path]).catch(() => null);
    previewPathCache.delete(assetId);
    return resolvePreviewPaths(assetId);
  }

  // Tools that draw from the preview (render_collage) need a RAW's HD one, or
  // its cells are upscaled from the 512px thumbnail; it isn't made at import.
  // Makes the missing ones, then reads those assets again. `details[i]` is
  // ids[i]'s; the result keeps that order.
  async function withRawHdPreviews(ids, details) {
    const missing = [];
    details.forEach((detail, i) => {
      if (detail?.asset_type === "raw" && detail.image_path && !detail.image_preview_hd_path) missing.push(i);
    });
    if (!missing.length) return details;
    for (let start = 0; start < missing.length; start += HD_ENSURE_CHUNK) {
      const paths = missing.slice(start, start + HD_ENSURE_CHUNK).map((i) => details[i].image_path);
      // A failure leaves those cells on the thumbnail rather than failing the render.
      await commands.ensureHdPreviews(paths).catch(() => null);
    }
    const next = [...details];
    for (const i of missing) {
      previewPathCache.delete(ids[i]);
      const fresh = await commands.assetDetail({ assetId: ids[i] }).catch(() => null);
      if (fresh?.image_path) next[i] = fresh;
    }
    return next;
  }

  // Derived versions (crops, text, collages, frames) go where the sidecar's
  // own derived outputs do — never next to the source, which would litter
  // the user's folders.
  function derivedOutputDir() {
    const dir = path.join(requireCatalog(), "derived");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---- Tool definitions: ./tools/*.js ---------------------------------------

  const tools = createTools({
    deps, commands, getCatalogState, port, sharp,
    startImportTask, formatJobStatus, registerRoots,
    requireCatalog, derivedOutputDir,
    rememberPreview, forgetPreview: (assetId) => previewPathCache.delete(assetId),
    resolvePreviewPaths, withRawHdPreviews,
  });

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  // ---- JSON-RPC dispatch ---------------------------------------------------

  async function handleRpc(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (method === "initialize") {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    if (isNotification) return null; // notifications/initialized etc. — ack with 202
    if (method === "ping") return jsonRpcResult(id, {});
    if (method === "tools/list") {
      return jsonRpcResult(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    }
    if (method === "tools/call") {
      const tool = toolsByName.get(params?.name);
      if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${params?.name}`);
      const content = [];
      try {
        const result = await tool.handler(params?.arguments || {}, { content });
        if (result !== null && result !== undefined) {
          content.push({ type: "text", text: JSON.stringify(result, null, 2) });
        }
        return jsonRpcResult(id, { content, isError: false });
      } catch (error) {
        console.error(`[mcp] tool ${params?.name} failed:`, error);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        });
      }
    }
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  // ---- HTTP server ---------------------------------------------------------

  async function serveAsset(req, res, url) {
    const assetId = decodeURIComponent(url.pathname.slice("/assets/".length));
    if (!assetId) {
      res.writeHead(400).end("missing asset id");
      return;
    }
    try {
      requireCatalog();
      const wantHd = url.searchParams.get("kind") === "hd";
      const { preview, previewHd } = wantHd
        ? await resolveHdPreviewPaths(assetId)
        : await resolvePreviewPaths(assetId);
      const filePath = (wantHd ? previewHd || preview : preview || previewHd);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404).end("no preview for asset");
        return;
      }
      const bytes = await fs.promises.readFile(filePath);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      res.end(bytes);
    } catch (error) {
      res.writeHead(500).end(String(error.message || error));
    }
  }

  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guards: this server is for local agents, never for web
    // pages. Origin catches browser fetches; Host catches rebound domains
    // pointing at 127.0.0.1 (no token by explicit user decision — local only).
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("forbidden origin");
      return;
    }
    const host = String(req.headers.host || "");
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith("/assets/") && req.method === "GET") {
      await serveAsset(req, res, url);
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          res.writeHead(413).end("payload too large");
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const responses = (await Promise.all(messages.map((m) => handleRpc(m)))).filter(Boolean);
      if (!responses.length) {
        res.writeHead(202).end();
        return;
      }
      const payload = Array.isArray(body) ? responses : responses[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404).end("not found");
  });

  // Settings → Integrations shows this, so a swallowed start failure is still
  // visible to the user instead of only in the log.
  let status = "starting";
  let lastError = null;

  function start() {
    return new Promise((resolve) => {
      server.once("error", (error) => {
        // Most likely EADDRINUSE from a second app instance — log and carry on,
        // the app itself must not be affected by MCP server failures.
        console.error("[mcp] server failed to start:", error.message);
        status = error.code === "EADDRINUSE" ? "port_in_use" : "error";
        lastError = error.message;
        resolve(null);
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(`[mcp] AfterFrame MCP server listening on http://127.0.0.1:${port}/mcp`);
        status = "running";
        resolve(server);
      });
    });
  }

  function getStatus() {
    return { status, port, url: `http://127.0.0.1:${port}/mcp`, toolCount: tools.length, error: lastError };
  }

  return { start, getStatus, server, port, clearPreviewCache: () => previewPathCache.clear() };
}

module.exports = { createMcpServer };
