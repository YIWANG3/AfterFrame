// Embedded MCP server — lets external AI agents (Claude Code, etc.) control
// AfterFrame while it runs. Speaks MCP streamable-HTTP (JSON-RPC over POST)
// on 127.0.0.1 only, plus a /assets/{id} endpoint that serves preview bytes
// so agents and chat UIs can actually see the images instead of file paths.
// Design doc: docs/agent-native-mcp.md

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 41706;
const SERVER_INFO = { name: "afterframe", version: "0.1.0" };

// Injected into every connecting agent's context via the initialize response —
// the crash course in AfterFrame's domain model that tool descriptions alone
// can't carry.
const SERVER_INSTRUCTIONS = `AfterFrame is a desktop photo library the user is running right now. You are operating on their real catalog.

Domain model:
- ASSET: one photo (an export/processed image, optionally paired with its RAW source file). Identified by asset_id.
- RESOURCE SET (version stack): a family of versions of the same photo — original, crops, AI repaints. crop_assets adds versions; originals are never modified.
- COLLECTION: a manual album. Smart collections are rule-based and read-only here.
- JOB: long-running background work (import / annotation / previews). Jobs appear in the app's JobDock where the user can watch and cancel them.

Working style:
- "These photos" / "this one" → call get_selection (the user's live selection in the app window).
- Locating photos by description → search_assets free-text matches filename, camera, AI caption, tags, OCR. If results are ambiguous, view_assets and look. Annotation coverage determines text-search quality — annotate_assets fills it.
- After finding or producing images for the user, prefer show_in_app over describing them: the app window is the best viewer. Use view_assets when YOU need to see them.
- Destructive-ish operations: crops/exports are non-destructive. delete_assets removes catalog records but never touches the original files on disk — still, confirm with the user before deleting unless they explicitly asked. Ratings/tags/collections are cheap to write and easy for the user to revert.
- Long jobs return a job_id immediately — poll get_job_status rather than blocking, and tell the user the job is visible in the app.

Paths: thumbnail_url fields are localhost HTTP URLs servable only on this machine.`;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VIEW_MAX_ASSETS = 8;
const VIEW_EDGE_PX = 384;
const IMPORT_WAIT_MS = 25000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // JSON-RPC requests are tiny; cap abuse
const VIEW_TIME_BUDGET_MS = 20000;

// asset_id -> { preview, previewHd } absolute paths, filled by search results
// so /assets/{id} usually serves without spawning the sidecar again.
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

function compactAsset(row, port) {
  const meta = row.image_metadata || {};
  return {
    asset_id: row.asset_id,
    stem: row.stem,
    image_path: row.image_path,
    rating: row.app_rating || 0,
    capture_time: meta.capture_time || null,
    camera: meta.camera_model || null,
    lens: meta.lens_model || null,
    iso: meta.iso ?? null,
    aperture: meta.aperture ?? null,
    focal_length: meta.focal_length ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    match_status: row.match_status,
    caption: row.annotation?.caption ?? null,
    tags: row.annotation?.tags?.length ? row.annotation.tags : undefined,
    has_raw: !!row.raw_asset_id,
    resource_set_id: row.resource_set_id || null,
    version_kind: row.version_kind || null,
    thumbnail_url: row.preview_path ? `http://127.0.0.1:${port}/assets/${row.asset_id}` : null,
  };
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
    callSidecarJsonAsync,
    callSidecarAsync,
    startImportTask,
    formatJobStatus,
    registerRoots,
    sharp,
    port = DEFAULT_PORT,
  } = deps;

  function requireCatalog() {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath) throw new Error("No catalog is open in AfterFrame.");
    if (!catalogHasDb()) throw new Error(`Catalog at ${currentCatalogPath} is empty (no database yet). Import something first.`);
    return currentCatalogPath;
  }

  async function resolvePreviewPaths(assetId) {
    const cached = previewPathCache.get(assetId);
    if (cached && (cached.preview || cached.previewHd)) return cached;
    let detail = null;
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

  async function getJob(jobId) {
    return await commands.getJob(jobId);
  }

  // ---- Tool definitions ----------------------------------------------------

  const tools = [
    {
      name: "get_catalog_info",
      description:
        "Overview of the currently open AfterFrame catalog: path, asset counts, and available search facets " +
        "(camera models, lens models, ISO/aperture/focal ranges, capture-time span). " +
        "Call this first to learn what values are valid for search_assets filters.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const catalogPath = requireCatalog();
        const [summaryRaw, facets] = await Promise.all([
          callSidecarAsync(["summary", "--json"]),
          commands.facetValues().catch(() => null),
        ]);
        return {
          catalog_path: catalogPath,
          summary: summaryRaw ? JSON.parse(summaryRaw) : null,
          facets,
        };
      },
    },
    {
      name: "search_assets",
      description:
        "Search photos in the catalog. Free-text `query` matches filename, path, camera, lens, AI caption, OCR text and tags. " +
        "All filters are AND-combined. Returns compact records including a `thumbnail_url` " +
        "(fetchable over local HTTP) — use view_assets to actually look at the images. " +
        "Results are paginated via limit/offset.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search across name, path, camera, lens, caption, OCR text, tags" },
          status: { type: "string", enum: ["all", "matched", "unmatched", "rated", "recent"], description: "Asset subset; 'recent' = imported in the last 7 days. Default all" },
          sort: { type: "string", enum: ["name-asc", "name-desc", "imported-desc", "imported-asc", "captured-desc", "captured-asc", "rating-desc"], description: "Default name-asc" },
          limit: { type: "number", description: "Max results, default 24" },
          offset: { type: "number" },
          camera: { type: "string", description: "Exact camera model (see get_catalog_info facets)" },
          lens: { type: "string", description: "Exact lens model" },
          iso_min: { type: "number" },
          iso_max: { type: "number" },
          aperture_min: { type: "number" },
          aperture_max: { type: "number" },
          focal_min: { type: "number", description: "Focal length lower bound (mm)" },
          focal_max: { type: "number" },
          date_from: { type: "string", description: "Capture date lower bound, ISO format e.g. 2026-05-01" },
          date_to: { type: "string" },
          rating_min: { type: "number", description: "Minimum star rating 1-5" },
          orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
          tag: { type: "string", description: "Exact tag match" },
        },
      },
      async handler(args) {
        requireCatalog();
        const filters = {};
        for (const key of [
          "camera", "lens", "iso_min", "iso_max", "aperture_min", "aperture_max",
          "focal_min", "focal_max", "date_from", "date_to", "rating_min", "orientation", "tag",
        ]) {
          if (args[key] !== undefined && args[key] !== null && args[key] !== "") filters[key] = args[key];
        }
        const rows = await commands.browseImages({
          status: args.status || "all",
          limit: args.limit || 24,
          offset: args.offset || 0,
          search: args.query ? String(args.query) : undefined,
          sort: args.sort ? String(args.sort) : undefined,
          filters,
        });
        for (const row of rows) rememberPreview(row.asset_id, row.preview_path, row.preview_hd_path);
        return {
          count: rows.length,
          assets: rows.map((row) => compactAsset(row, port)),
        };
      },
    },
    {
      name: "get_asset",
      description:
        "Full detail for one asset by id: complete EXIF metadata, RAW match status and candidates, " +
        "version siblings in its resource set (crops, AI repaints), and duplicates.",
      inputSchema: {
        type: "object",
        properties: { asset_id: { type: "string" } },
        required: ["asset_id"],
      },
      async handler(args) {
        requireCatalog();
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        rememberPreview(detail?.asset_id, detail?.image_preview_path, detail?.image_preview_hd_path);
        return detail;
      },
    },
    {
      name: "view_assets",
      description:
        `Return small preview images (max ${VIEW_MAX_ASSETS} per call) so you can visually inspect photos — ` +
        "use after search_assets to judge content, pick the best shots, or confirm which photo the user means.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: `Asset ids to view, max ${VIEW_MAX_ASSETS}` },
        },
        required: ["asset_ids"],
      },
      async handler(args, { content }) {
        requireCatalog();
        const ids = (args.asset_ids || []).slice(0, VIEW_MAX_ASSETS);
        const skipped = (args.asset_ids || []).length - ids.length;
        const deadline = Date.now() + VIEW_TIME_BUDGET_MS;
        for (const assetId of ids) {
          if (Date.now() > deadline) {
            content.push({ type: "text", text: "(time budget exhausted — remaining ids skipped)" });
            break;
          }
          const { preview, previewHd } = await resolvePreviewPaths(assetId);
          const source = preview || previewHd;
          if (!source || !fs.existsSync(source)) {
            content.push({ type: "text", text: `${assetId}: no preview available (previews may still be generating)` });
            continue;
          }
          const buffer = await sharp(source, { limitInputPixels: false })
            .resize(VIEW_EDGE_PX, VIEW_EDGE_PX, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
          content.push({ type: "text", text: `asset ${assetId}:` });
          content.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" });
        }
        if (skipped > 0) content.push({ type: "text", text: `(${skipped} more ids skipped — max ${VIEW_MAX_ASSETS} per call)` });
        return null; // content already assembled
      },
    },
    {
      name: "show_in_app",
      description:
        "Show photos to the USER: brings the AfterFrame window to front, selects the given assets in the " +
        "gallery and scrolls to them. The app is the best image viewer — prefer this over describing images " +
        "when the user wants to see results (e.g. after search_assets). Returns which ids were actually revealed.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: "Asset ids to select in the app" },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.revealAssetsInApp) throw new Error("App window bridge unavailable.");
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        return await deps.revealAssetsInApp(ids);
      },
    },
    {
      name: "get_selection",
      description:
        "What the user currently has selected in the AfterFrame window. Call this when the user says " +
        "\"these photos\", \"this one\", \"my selection\" etc. Returns asset ids plus names/paths; " +
        "use view_assets on the ids to see them.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        requireCatalog();
        const selection = deps.getCurrentSelection ? deps.getCurrentSelection() : { assets: [], updatedAt: null };
        return {
          count: selection.assets.length,
          updated_at: selection.updatedAt,
          assets: selection.assets,
          note: selection.assets.length ? undefined : "Nothing is selected in the app right now.",
        };
      },
    },
    {
      name: "update_assets",
      description:
        "Batch-edit asset metadata: set star rating (0-5, 0 clears) and/or add/remove tags. " +
        "The app UI refreshes automatically. Tags power search; ratings power the 'rated' filter and smart collections.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          rating: { type: "number", description: "Star rating 0-5; 0 clears the rating" },
          add_tags: { type: "array", items: { type: "string" } },
          remove_tags: { type: "array", items: { type: "string" } },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const addTags = (args.add_tags || []).map(String).filter(Boolean);
        const removeTags = (args.remove_tags || []).map(String).filter(Boolean);
        const hasRating = args.rating !== undefined && args.rating !== null;
        if (!hasRating && !addTags.length && !removeTags.length) {
          throw new Error("Nothing to do — pass rating, add_tags and/or remove_tags.");
        }
        let mutated = false;
        const errors = [];
        try {
          if (hasRating) {
            const rating = Number(args.rating);
            if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error("rating must be an integer 0-5.");
            await commands.setAssetRating(ids, rating);
            mutated = true;
          }
          // Sequential on purpose: SQLite single-writer, and per-asset-per-tag CLI.
          // Per-asset errors are collected, not thrown — a mid-loop failure must
          // not hide the writes that already landed.
          for (const id of ids) {
            for (const tag of addTags) {
              try {
                await commands.addAssetTag(id, tag);
                mutated = true;
              } catch (error) {
                errors.push({ asset_id: id, op: `add_tag:${tag}`, error: error.message });
              }
            }
            for (const tag of removeTags) {
              try {
                await commands.removeAssetTag(id, tag);
                mutated = true;
              } catch (error) {
                errors.push({ asset_id: id, op: `remove_tag:${tag}`, error: error.message });
              }
            }
          }
        } finally {
          // The UI must hear about whatever DID change, even on partial failure.
          if (mutated) deps.broadcastCatalogChanged?.("assets", { ids });
        }
        return {
          updated: ids.length - new Set(errors.map((e) => e.asset_id)).size,
          rating: hasRating ? Number(args.rating) : undefined,
          added_tags: addTags.length ? addTags : undefined,
          removed_tags: removeTags.length ? removeTags : undefined,
          errors: errors.length ? errors : undefined,
        };
      },
    },
    {
      name: "manage_collections",
      description:
        "Collections (albums/folders) management. Actions: 'list' all collections; 'create' (name); " +
        "'rename' (collection_id, name); 'delete' (collection_id); 'add_items' / 'remove_items' " +
        "(collection_id, asset_ids); 'browse' (collection_id, limit/offset) to list a collection's assets.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "rename", "delete", "add_items", "remove_items", "browse"] },
          collection_id: { type: "string" },
          name: { type: "string", description: "For create/rename" },
          asset_ids: { type: "array", items: { type: "string" }, description: "For add_items/remove_items" },
          limit: { type: "number", description: "For browse, default 24" },
          offset: { type: "number", description: "For browse" },
        },
        required: ["action"],
      },
      async handler(args) {
        requireCatalog();
        const action = args.action;
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        const needsId = ["rename", "delete", "add_items", "remove_items", "browse"];
        if (needsId.includes(action) && !args.collection_id) throw new Error(`collection_id is required for ${action}.`);
        if (action === "list") {
          return { collections: await commands.listCollections() };
        }
        if (action === "create") {
          if (!args.name) throw new Error("name is required for create.");
          const created = await commands.createCollection(String(args.name), "manual");
          deps.broadcastCatalogChanged?.("collections");
          return created;
        }
        if (action === "rename") {
          if (!args.name) throw new Error("name is required for rename.");
          const updated = await commands.updateCollection(String(args.collection_id), { name: String(args.name) });
          deps.broadcastCatalogChanged?.("collections");
          return updated;
        }
        if (action === "delete") {
          const deleted = await commands.deleteCollection(String(args.collection_id));
          deps.broadcastCatalogChanged?.("collections");
          return deleted;
        }
        if (action === "add_items" || action === "remove_items") {
          if (!ids.length) throw new Error(`asset_ids is required for ${action}.`);
          const result = action === "add_items"
            ? await commands.collectionAddItems(String(args.collection_id), ids)
            : await commands.collectionRemoveItems(String(args.collection_id), ids);
          deps.broadcastCatalogChanged?.("collections");
          return result;
        }
        if (action === "browse") {
          const rows = await commands.browseCollection(String(args.collection_id), {
            limit: args.limit || 24,
            offset: args.offset || 0,
          });
          for (const row of rows) rememberPreview(row.asset_id, row.preview_path, row.preview_hd_path);
          return { count: rows.length, assets: rows.map((row) => compactAsset(row, port)) };
        }
        throw new Error(`Unknown action: ${action}`);
      },
    },
    {
      name: "annotate_assets",
      description:
        "Run AI auto-annotation (caption + tags + OCR text) over assets using the provider configured in the app's " +
        "Settings → AI. Scope: pass asset_ids, or collection_id, or neither for the whole library. " +
        "Skips already-annotated assets unless reannotate=true. Long-running: returns a job_id — " +
        "poll get_job_status; results then feed free-text search.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          collection_id: { type: "string" },
          reannotate: { type: "boolean", description: "Overwrite existing annotations. Default false" },
        },
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startAnnotationTask) throw new Error("Annotation bridge unavailable.");
        const assetIds = (args.asset_ids || []).map(String).filter(Boolean);
        const scope = assetIds.length ? "selection" : args.collection_id ? "collection" : "all";
        const status = await deps.startAnnotationTask({
          scope,
          assetIds,
          collectionId: args.collection_id || null,
          onlyMissing: !args.reannotate,
        });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "annotation" });
        return {
          job_id: status.jobId,
          status: status.status,
          running: status.running,
          note: "Annotation runs in the background — poll get_job_status. The job is visible in the app's JobDock.",
        };
      },
    },
    {
      name: "import_directory",
      description:
        "Import media into the catalog. `image_dirs` are folders/files of processed images (JPEG/PNG/WebP/HEIC); " +
        "`raw_dirs` are folders of RAW camera files. Provide either or both. Starts an import job " +
        `(scan → match → previews) and waits up to ${IMPORT_WAIT_MS / 1000}s; if still running, returns the job_id — ` +
        "poll with get_job_status. The job is also visible (and cancellable) in the app's JobDock.",
      inputSchema: {
        type: "object",
        properties: {
          image_dirs: { type: "array", items: { type: "string" }, description: "Absolute paths of processed-image folders or files" },
          raw_dirs: { type: "array", items: { type: "string" }, description: "Absolute paths of RAW source folders or files" },
        },
      },
      async handler(args) {
        const { currentCatalogPath } = getCatalogState();
        if (!currentCatalogPath) throw new Error("No catalog is open in AfterFrame.");
        const imageDirs = (args.image_dirs || []).map((p) => String(p)).filter(Boolean);
        const rawDirs = (args.raw_dirs || []).map((p) => String(p)).filter(Boolean);
        if (!imageDirs.length && !rawDirs.length) {
          throw new Error("Provide image_dirs and/or raw_dirs (absolute paths).");
        }
        for (const target of [...imageDirs, ...rawDirs]) {
          if (!fs.existsSync(target)) throw new Error(`Path does not exist: ${target}`);
        }
        const mode = imageDirs.length && rawDirs.length ? "combined" : imageDirs.length ? "processed_only" : "source_only";
        if (rawDirs.length) await registerRoots("raw", rawDirs);
        if (imageDirs.length) await registerRoots("image", imageDirs);
        let status = await startImportTask({ mode, rawDirs, imageDirs: imageDirs });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "import" });
        const deadline = Date.now() + IMPORT_WAIT_MS;
        while (status.running && status.jobId && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          status = formatJobStatus(await getJob(status.jobId));
        }
        return {
          done: !status.running,
          job_id: status.jobId,
          status: status.status,
          progress: status.progress,
          phase: status.phaseLabel || status.phase,
          result: status.running ? null : status.result,
          error: status.error,
          note: status.running ? "Import still running — poll get_job_status with this job_id." : undefined,
        };
      },
    },
    {
      name: "crop_assets",
      description:
        "Crop photos to an aspect ratio (e.g. '4:3', '1:1', '16:9'). Non-destructive: each crop becomes a new " +
        "derived version in the original's version stack — the original is untouched. EXIF is preserved and the " +
        "RAW pairing is inherited. Returns the new asset ids with thumbnail URLs; use show_in_app to present results.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          ratio: { type: "string", description: "Target aspect ratio like '4:3', '1:1', '16:9', '3:4'" },
          gravity: { type: "string", enum: ["center", "top", "bottom", "left", "right"], description: "Which part to keep. Default center" },
        },
        required: ["asset_ids", "ratio"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const results = [];
        // Sequential: SQLite single-writer + full-res image decode per call.
        for (const id of ids) {
          try {
            const payload = await commands.createDerived({
              assetId: id,
              ratio: String(args.ratio),
              gravity: String(args.gravity || "center"),
            });
            rememberPreview(payload.asset_id, null, null);
            results.push({
              source_asset_id: id,
              new_asset_id: payload.asset_id,
              width: payload.width,
              height: payload.height,
              path: payload.image_path,
              thumbnail_url: `http://127.0.0.1:${port}/assets/${payload.asset_id}`,
            });
          } catch (error) {
            results.push({ source_asset_id: id, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { ratio: args.ratio, results };
      },
    },
    {
      name: "export_assets",
      description:
        "Export photos out of the library to a folder on disk — optionally resized (max_edge) and/or transcoded " +
        "(jpeg/png/webp). EXIF is preserved. Use for 'export these to ~/Desktop/xx at 2048px' style requests. " +
        "Does not modify the catalog.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          dest_dir: { type: "string", description: "Destination folder (absolute path; created if missing)" },
          max_edge: { type: "number", description: "Resize so the longest edge fits this many pixels" },
          format: { type: "string", enum: ["jpeg", "png", "webp"], description: "Transcode to this format; default keeps original" },
          quality: { type: "number", description: "JPEG/WebP quality 1-100, default 90" },
        },
        required: ["asset_ids", "dest_dir"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        if (!args.dest_dir) throw new Error("dest_dir is required.");
        // Write-side constraint: exports land under the user's home or the
        // temp dir — never system locations, no matter what the agent passes.
        const destResolved = path.resolve(String(args.dest_dir));
        const allowedPrefixes = [os.homedir(), os.tmpdir()].map((d) => path.resolve(d));
        if (!allowedPrefixes.some((d) => destResolved === d || destResolved.startsWith(d + path.sep))) {
          throw new Error(`dest_dir must be inside your home directory or the temp dir (got ${destResolved}).`);
        }
        const results = await commands.exportAssets({
          assetIds: ids,
          dest: destResolved,
          maxEdge: args.max_edge,
          format: args.format,
          quality: args.quality,
        });
        const failed = results.filter((r) => r.error);
        return {
          exported: results.length - failed.length,
          failed: failed.length || undefined,
          results,
        };
      },
    },
    {
      name: "repaint_asset",
      description:
        "AI image generation on a photo (image-to-image) using the provider configured in the app's Settings → AI: " +
        "restyle, repaint, enhance, upscale per the prompt. The result is registered as a new version in the " +
        "original's version stack. Long-running: returns a job_id — poll get_job_status, then show_in_app the result.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          prompt: { type: "string", description: "What to generate/change, in natural language" },
          model: { type: "string", description: "Provider-specific model id; default uses the provider's default" },
          aspect_ratio: { type: "string", description: "e.g. '4:3', '1:1'; default keeps the source ratio" },
        },
        required: ["asset_id", "prompt"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startAiRepaintTask || !deps.readAppSettings) throw new Error("Repaint bridge unavailable.");
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        if (!detail?.image_path) throw new Error(`No file path for asset ${args.asset_id}.`);
        const prefs = deps.readAppSettings()?.aiPreferences || {};
        const providers = Array.isArray(prefs.providers) ? prefs.providers : [];
        const active = providers.find((p) => p.id === prefs.activeProvider) || providers[0];
        if (!active) throw new Error("No AI repaint provider configured. Open Settings → AI to add one.");
        // Model precedence: explicit arg > the user's pick in the app UI
        // (selectedModels) > sidecar's per-provider default.
        const uiModel = prefs.selectedModels?.[active.id] || "";
        const status = await deps.startAiRepaintTask({
          sourcePath: detail.image_path,
          prompt: String(args.prompt),
          provider: active.id,
          providerType: active.type,
          model: args.model ? String(args.model) : uiModel,
          aspectRatio: args.aspect_ratio || null,
        });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "ai_repaint" });
        return {
          job_id: status.jobId,
          status: status.status,
          provider: active.name || active.type,
          note: "Generation runs in the background — poll get_job_status. The result lands in the original's version stack.",
        };
      },
    },
    {
      name: "delete_assets",
      description:
        "Remove assets from the catalog (records, previews, version-stack membership). The original image files " +
        "on disk are NOT touched. Confirm with the user first unless they explicitly asked to delete.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const results = await commands.deleteImageAssets(ids);
        for (const id of ids) previewPathCache.delete(id);
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { deleted: results.length, results };
      },
    },
    {
      name: "get_job_status",
      description: "Status of a background job by job_id (returned by import_directory / list_active_jobs).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        return formatJobStatus(await getJob(args.job_id));
      },
    },
    {
      name: "list_active_jobs",
      description: "All queued or running background jobs (import, enrichment, preview, ai_repaint, annotation).",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const { currentCatalogPath, catalogHasDb } = getCatalogState();
        if (!currentCatalogPath || !catalogHasDb()) return { jobs: [] };
        const jobs = await commands.listActiveJobs();
        return {
          jobs: jobs.map((job) => ({
            ...formatJobStatus(job),
            jobType: job.job_type,
            cancel_requested: !!job.cancel_requested,
          })),
        };
      },
    },
    {
      name: "cancel_job",
      description: "Request cooperative cancellation of a running job. The runner stops at its next checkpoint.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.cancelJob(String(args.job_id));
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
  ];

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
      const { preview, previewHd } = await resolvePreviewPaths(assetId);
      const wantHd = url.searchParams.get("kind") === "hd";
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

  function start() {
    return new Promise((resolve) => {
      server.once("error", (error) => {
        // Most likely EADDRINUSE from a second app instance — log and carry on,
        // the app itself must not be affected by MCP server failures.
        console.error("[mcp] server failed to start:", error.message);
        resolve(null);
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(`[mcp] AfterFrame MCP server listening on http://127.0.0.1:${port}/mcp`);
        resolve(server);
      });
    });
  }

  return { start, server, port };
}

module.exports = { createMcpServer, DEFAULT_PORT };
