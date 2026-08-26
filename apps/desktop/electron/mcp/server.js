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
- ASSET: one photo or video (an export/processed file, optionally paired with its RAW source file). Identified by asset_id; asset_type tells photos and videos apart.
- RESOURCE SET (version stack): a family of versions of the same photo — original, crops, text overlays, AI repaints. crop_assets/add_text add versions; originals are never modified.
- COLLECTION: a manual album. Smart collections are rule-based and read-only here.
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
    asset_type: row.asset_type || "image",
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
    duration: row.asset_type === "video" ? meta.duration ?? null : undefined,
    match_status: row.match_status,
    caption: row.annotation?.caption ?? null,
    tags: row.annotation?.tags?.length ? row.annotation.tags : undefined,
    has_raw: !!row.raw_asset_id,
    has_face: row.has_face ? true : undefined,
    // Only surfaced when something is wrong — keeps the common case compact.
    missing_original: row.exists_on_disk === false ? true : undefined,
    source_changed: row.source_changed === true ? true : undefined,
    resource_set_id: row.resource_set_id || null,
    version_kind: row.version_kind || null,
    thumbnail_url: row.preview_path ? `http://127.0.0.1:${port}/assets/${row.asset_id}` : null,
  };
}

// {lat, lng, km} → the bounds-mode bbox the sidecar's geo filter understands.
function nearToBounds(near) {
  const lat = Number(near.lat);
  const lng = Number(near.lng);
  const km = Number(near.km) || 5;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("near requires numeric lat and lng.");
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    mode: "bounds",
    west: Math.max(-180, lng - dLng),
    east: Math.min(180, lng + dLng),
    south: Math.max(-90, lat - dLat),
    north: Math.min(90, lat + dLat),
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
          asset_type: { type: "string", enum: ["image", "video"], description: "Only photos or only videos" },
          extension: { type: "string", description: "File format, e.g. 'jpg', 'png', 'mp4', 'cr2'" },
          shutter_min: { type: "number", description: "Shutter speed lower bound in seconds (e.g. 0.001 for 1/1000s)" },
          shutter_max: { type: "number" },
          people: { type: "string", enum: ["with_faces", "without_faces"], description: "Filter by detected faces" },
          person_id: { type: "string", description: "Only photos of this person (a people group id from list_people)" },
          annotated: { type: "string", enum: ["with", "without"], description: "Whether AI annotation exists" },
          geo: {
            type: "object",
            description: "Location filter. Either bounds {west,south,east,north} (degrees), or near {lat,lng,km}. " +
              "min_precision (exact|locality|admin1|country) drops coarse AI guesses; default includes all.",
            properties: {
              west: { type: "number" }, south: { type: "number" }, east: { type: "number" }, north: { type: "number" },
              near: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" }, km: { type: "number" } } },
              min_precision: { type: "string", enum: ["exact", "locality", "admin1", "country"] },
            },
          },
        },
      },
      async handler(args) {
        requireCatalog();
        const filters = {};
        for (const key of [
          "camera", "lens", "iso_min", "iso_max", "aperture_min", "aperture_max",
          "focal_min", "focal_max", "date_from", "date_to", "rating_min", "orientation", "tag",
          "asset_type", "extension", "shutter_min", "shutter_max", "people", "annotated",
        ]) {
          if (args[key] !== undefined && args[key] !== null && args[key] !== "") filters[key] = args[key];
        }
        if (args.person_id) filters.person_group = String(args.person_id);
        if (args.geo && typeof args.geo === "object") {
          const geo = args.geo.near
            ? nearToBounds(args.geo.near)
            : { mode: "bounds", west: args.geo.west, south: args.geo.south, east: args.geo.east, north: args.geo.north };
          for (const edge of ["west", "south", "east", "north"]) {
            if (!Number.isFinite(Number(geo[edge]))) throw new Error("geo requires either near{lat,lng,km} or all of west/south/east/north.");
          }
          if (args.geo.min_precision) geo.min_precision = args.geo.min_precision;
          filters.geo = geo;
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
        "version siblings in its resource set (crops, AI repaints), duplicates, effective location " +
        "(GPS or AI-resolved) and AI-repaint history.",
      inputSchema: {
        type: "object",
        properties: { asset_id: { type: "string" } },
        required: ["asset_id"],
      },
      async handler(args) {
        requireCatalog();
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        rememberPreview(detail?.asset_id, detail?.image_preview_path, detail?.image_preview_hd_path);
        // Best-effort enrichments — a missing gazetteer or history must not
        // break basic detail reads.
        const [location, repaintHistory] = await Promise.all([
          commands.getAssetLocation(String(args.asset_id)).catch(() => null),
          detail?.image_path ? commands.listRepaintHistory(detail.image_path).catch(() => []) : [],
        ]);
        return {
          ...detail,
          location: location || null,
          repaint_history: repaintHistory?.length ? repaintHistory : undefined,
        };
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
        "Show something to the USER in the AfterFrame window (brings it to front). Default view 'gallery' " +
        "selects the given assets and scrolls to them — prefer this over describing images. Other views hand " +
        "the baton to the user: 'editor' opens the first asset in the image editor, 'collage' opens the collage " +
        "composer with the assets, 'people' / 'stickers' switch to those library views (no asset_ids needed).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: "Asset ids (required for gallery/editor/collage)" },
          view: { type: "string", enum: ["gallery", "editor", "collage", "people", "stickers"], description: "Default gallery" },
        },
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        const view = args.view || "gallery";
        if (view === "gallery") {
          if (!deps.revealAssetsInApp) throw new Error("App window bridge unavailable.");
          if (!ids.length) throw new Error("asset_ids is empty.");
          return await deps.revealAssetsInApp(ids);
        }
        if (!deps.askRenderer) throw new Error("App window bridge unavailable.");
        // Views resolve assets from the gallery's current item map — reveal
        // first so the items are guaranteed loaded (and the window is front).
        if (ids.length && deps.revealAssetsInApp) await deps.revealAssetsInApp(ids);
        return await deps.askRenderer("open_view", { view, assetIds: ids }, { timeoutMs: 15_000 });
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
          sort_order: { type: "number", description: "For rename: optional new position in the sidebar" },
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
          if (!args.name && args.sort_order == null) throw new Error("name and/or sort_order is required for rename.");
          const updated = await commands.updateCollection(String(args.collection_id), {
            name: args.name != null ? String(args.name) : undefined,
            sortOrder: args.sort_order != null ? Number(args.sort_order) : undefined,
          });
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
        "Crop / rotate / flip photos. Two modes: (1) `ratio` (e.g. '4:3', '1:1') with optional gravity — " +
        "aspect-ratio crop; (2) `rect` (normalized 0-1 {x,y,w,h}) and/or quarter_turns / free_angle / " +
        "flip_x / flip_y — the same arbitrary geometry the app's editor offers, applied at full source " +
        "resolution. Non-destructive: each result becomes a new derived version in the original's version " +
        "stack — the original is untouched. EXIF is preserved and the RAW pairing is inherited.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          ratio: { type: "string", description: "Mode 1: target aspect ratio like '4:3', '1:1', '16:9', '3:4'" },
          gravity: { type: "string", enum: ["center", "top", "bottom", "left", "right"], description: "Mode 1: which part to keep. Default center" },
          rect: {
            type: "object",
            description: "Mode 2: normalized crop rectangle (0-1, relative to the rotated image)",
            properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          },
          quarter_turns: { type: "number", description: "Mode 2: 90° clockwise turns (0-3)" },
          free_angle: { type: "number", description: "Mode 2: additional fine rotation in degrees (-45..45)" },
          flip_x: { type: "boolean" },
          flip_y: { type: "boolean" },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const advanced = !!(args.rect || args.quarter_turns || args.free_angle || args.flip_x || args.flip_y);
        if (!advanced && !args.ratio) throw new Error("Pass ratio, or rect / rotation / flip arguments.");
        if (advanced && args.ratio) throw new Error("ratio and rect/rotation modes are mutually exclusive.");
        if (advanced && !deps.processAndSave) throw new Error("Geometry pipeline unavailable.");
        const results = [];
        // Sequential: SQLite single-writer + full-res image decode per call.
        for (const id of ids) {
          try {
            let payload;
            if (!advanced) {
              payload = await commands.createDerived({
                assetId: id,
                ratio: String(args.ratio),
                gravity: String(args.gravity || "center"),
              });
            } else {
              const detail = await commands.assetDetail({ assetId: id });
              if (!detail?.image_path) throw new Error("no file path for asset");
              const src = detail.image_path;
              const ext = /\.(png|webp)$/i.test(src) ? path.extname(src).toLowerCase() : ".jpg";
              // Same destination as the sidecar's own derived outputs — never
              // next to the source (that would litter the user's folders).
              const derivedDir = path.join(requireCatalog(), "derived");
              fs.mkdirSync(derivedDir, { recursive: true });
              const savePath = path.join(
                derivedDir,
                `${path.basename(src).replace(/\.[^.]+$/, "")}_edit_${Date.now()}${ext}`,
              );
              const rect = args.rect;
              await deps.processAndSave({
                sourcePath: src,
                savePath,
                quarterTurns: Number(args.quarter_turns) || 0,
                freeAngle: Number(args.free_angle) || 0,
                flipX: !!args.flip_x,
                flipY: !!args.flip_y,
                crop: rect ? { x: Number(rect.x) || 0, y: Number(rect.y) || 0, width: Number(rect.w), height: Number(rect.h) } : undefined,
              });
              payload = await commands.quickRegister({ imagePath: savePath, originPath: src });
            }
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
        return { results };
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
    {
      name: "pause_job",
      description: "Pause a running job at its next checkpoint (resumable later with resume_job).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.pauseJob(String(args.job_id));
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
    {
      name: "resume_job",
      description: "Resume a paused job.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        const jobId = String(args.job_id);
        // people_index needs its worker process relaunched, not just a status
        // flip — same routing as the app's Activity Center resume button.
        const job = await getJob(jobId);
        let result;
        if (job?.job_type === "people_index" && deps.resumePeopleIndexJob) {
          result = await deps.resumePeopleIndexJob(jobId);
        } else {
          result = await commands.resumeJob(jobId);
        }
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
    {
      name: "list_people",
      description:
        "Recognized people (face groups) in the catalog: id, name (if the user named them), face count, state " +
        "(candidate/confirmed/ignored) and cover thumbnail. Use the group id with search_assets person_id to " +
        "find someone's photos, or with get_person / update_person.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["candidate", "confirmed", "ignored"], description: "Filter by state; default all non-ignored" },
        },
      },
      async handler(args) {
        requireCatalog();
        const groups = await commands.listPeopleGroups({ state: args.state });
        return { count: groups.length, people: groups };
      },
    },
    {
      name: "get_person",
      description:
        "Detail for one people group: name, state, faces (paginated — each face has its asset_id), and " +
        "optionally similar groups that might be the same person (merge candidates for update_person).",
      inputSchema: {
        type: "object",
        properties: {
          person_id: { type: "string" },
          face_limit: { type: "number", description: "Max faces to return, default 24" },
          face_offset: { type: "number" },
          include_similar: { type: "boolean", description: "Also return likely-same-person groups" },
        },
        required: ["person_id"],
      },
      async handler(args) {
        requireCatalog();
        const groupId = String(args.person_id);
        const [detail, similar] = await Promise.all([
          commands.peopleGroupDetail({ groupId, faceLimit: args.face_limit || 24, faceOffset: args.face_offset || 0 }),
          args.include_similar ? commands.similarPeopleGroups({ groupId }).catch(() => []) : null,
        ]);
        return { ...detail, similar: similar || undefined };
      },
    },
    {
      name: "update_person",
      description:
        "Edit a people group. Actions: 'rename' (name); 'set_cover' (face_id); 'set_state' " +
        "(state: confirmed accepts the person, ignored hides the group and a rescan will NOT restore it — " +
        "confirm with the user first); 'merge' (merge this group INTO target_person_id); " +
        "'assign_faces' / 'remove_faces' (face_ids — move faces into this group / detach them).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["rename", "set_cover", "set_state", "merge", "assign_faces", "remove_faces"] },
          person_id: { type: "string" },
          name: { type: "string", description: "For rename" },
          face_id: { type: "string", description: "For set_cover" },
          face_ids: { type: "array", items: { type: "string" }, description: "For assign_faces/remove_faces" },
          state: { type: "string", enum: ["candidate", "confirmed", "ignored"], description: "For set_state" },
          target_person_id: { type: "string", description: "For merge: the group that survives" },
        },
        required: ["action", "person_id"],
      },
      async handler(args) {
        requireCatalog();
        const groupId = String(args.person_id);
        let result;
        if (args.action === "rename") {
          if (!args.name) throw new Error("name is required for rename.");
          result = await commands.renamePeopleGroup({ groupId, name: String(args.name) });
        } else if (args.action === "set_cover") {
          if (!args.face_id) throw new Error("face_id is required for set_cover.");
          result = await commands.setPeopleGroupCover({ groupId, faceId: String(args.face_id) });
        } else if (args.action === "set_state") {
          if (!args.state) throw new Error("state is required for set_state.");
          result = await commands.setPeopleGroupState({ groupId, state: String(args.state) });
        } else if (args.action === "merge") {
          if (!args.target_person_id) throw new Error("target_person_id is required for merge.");
          result = await commands.mergePeopleGroups({ sourceGroupId: groupId, targetGroupId: String(args.target_person_id) });
        } else if (args.action === "assign_faces") {
          const faceIds = (args.face_ids || []).map(String).filter(Boolean);
          if (!faceIds.length) throw new Error("face_ids is required for assign_faces.");
          result = await commands.assignFaceToPerson({ faceIds, groupId });
        } else if (args.action === "remove_faces") {
          const faceIds = (args.face_ids || []).map(String).filter(Boolean);
          if (!faceIds.length) throw new Error("face_ids is required for remove_faces.");
          result = await commands.removeFaceFromPerson({ faceIds });
        } else {
          throw new Error(`Unknown action: ${args.action}`);
        }
        deps.broadcastCatalogChanged?.("people");
        return result;
      },
    },
    {
      name: "index_people",
      description:
        "Run face recognition over the library (or specific assets) using the app's local Core ML model. " +
        "Fully offline. Long-running: returns a job_id — poll get_job_status. Fails with guidance when no " +
        "face model is installed (the user sets one up in Settings → People).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: "Limit to these assets; default whole catalog" },
        },
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startPeopleIndex) throw new Error("People indexing bridge unavailable.");
        const status = await deps.startPeopleIndex({ assetIds: (args.asset_ids || []).map(String).filter(Boolean) });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "people_index" });
        return {
          job_id: status.jobId,
          status: status.status,
          note: "Recognition runs in the background — poll get_job_status. People appear in the app's People view as they are found.",
        };
      },
    },
    {
      name: "browse_map",
      description:
        "Photo locations for map-style queries: returns {asset_id, latitude, longitude, precision, source} points. " +
        "Scope with the same free-text query as search_assets, and/or a collection. min_precision hides coarse " +
        "AI-guessed locations (default locality). To filter full asset records by area instead, use " +
        "search_assets with the geo filter.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text scope, same as search_assets query" },
          collection_id: { type: "string" },
          min_precision: { type: "string", enum: ["exact", "locality", "admin1", "country"], description: "Default locality" },
          limit: { type: "number", description: "Default 5000" },
        },
      },
      async handler(args) {
        requireCatalog();
        const points = await commands.browseMapPoints({
          collectionId: args.collection_id,
          search: args.query,
          minPrecision: args.min_precision,
          limit: args.limit || 5000,
        });
        return { count: points.length, points };
      },
    },
    {
      name: "set_asset_location",
      description:
        "Set or clear a photo's location pin. action 'set' writes a manual location (lat/lng — overrides EXIF " +
        "and AI guesses); 'clear' removes the pin (EXIF GPS, if the file has any, comes back); " +
        "'resolve_ai' backfills locations from existing AI annotations' place guesses for the whole catalog.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "clear", "resolve_ai"] },
          asset_ids: { type: "array", items: { type: "string" }, description: "For set/clear" },
          lat: { type: "number" },
          lng: { type: "number" },
        },
        required: ["action"],
      },
      async handler(args) {
        requireCatalog();
        if (args.action === "resolve_ai") {
          const result = await commands.resolveAiLocations();
          deps.broadcastCatalogChanged?.("assets");
          return result;
        }
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        if (args.action === "set" && (!Number.isFinite(Number(args.lat)) || !Number.isFinite(Number(args.lng)))) {
          throw new Error("lat and lng are required for set.");
        }
        const results = [];
        for (const id of ids) {
          try {
            const location = await commands.setAssetLocation({
              assetId: id,
              lat: args.lat,
              lng: args.lng,
              clear: args.action === "clear",
            });
            results.push({ asset_id: id, location });
          } catch (error) {
            results.push({ asset_id: id, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { results };
      },
    },
    {
      name: "maintain_library",
      description:
        "Library housekeeping. Actions: 'verify_assets' — sweep for missing/changed originals (scope all|missing); " +
        "'refresh_from_disk' (asset_ids) — re-read metadata and regenerate previews after files changed on disk; " +
        "'relink' (asset_id, new_path) — point a missing asset at its moved file; " +
        "'scan_new_media' (dirs) — one-shot import sweep of folders; " +
        "'list_watched_dirs' / 'add_watched_dir' / 'remove_watched_dir' (dir) — folders the app auto-imports from.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["verify_assets", "refresh_from_disk", "relink", "scan_new_media", "list_watched_dirs", "add_watched_dir", "remove_watched_dir"] },
          scope: { type: "string", enum: ["all", "missing"], description: "For verify_assets, default all" },
          asset_ids: { type: "array", items: { type: "string" }, description: "For refresh_from_disk" },
          asset_id: { type: "string", description: "For relink" },
          new_path: { type: "string", description: "For relink" },
          dirs: { type: "array", items: { type: "string" }, description: "For scan_new_media" },
          dir: { type: "string", description: "For add_watched_dir/remove_watched_dir" },
        },
        required: ["action"],
      },
      async handler(args) {
        requireCatalog();
        const action = args.action;
        if (action === "verify_assets") {
          const result = await commands.verifyAssets({ scope: args.scope || "all" });
          deps.broadcastCatalogChanged?.("assets");
          return result;
        }
        if (action === "refresh_from_disk") {
          const ids = (args.asset_ids || []).map(String).filter(Boolean);
          if (!ids.length) throw new Error("asset_ids is required for refresh_from_disk.");
          const paths = [];
          for (const id of ids) {
            const detail = await commands.assetDetail({ assetId: id }).catch(() => null);
            if (detail?.image_path) paths.push(detail.image_path);
          }
          if (!paths.length) throw new Error("None of the asset_ids resolved to a file path.");
          const result = await commands.refreshAssets(paths);
          deps.broadcastCatalogChanged?.("assets", { ids });
          return result;
        }
        if (action === "relink") {
          if (!args.asset_id || !args.new_path) throw new Error("asset_id and new_path are required for relink.");
          if (!fs.existsSync(String(args.new_path))) throw new Error(`Path does not exist: ${args.new_path}`);
          const result = await commands.relinkAsset({ assetId: String(args.asset_id), newPath: String(args.new_path) });
          deps.broadcastCatalogChanged?.("assets", { ids: [String(args.asset_id)] });
          return result;
        }
        if (action === "scan_new_media") {
          const dirs = (args.dirs || []).map(String).filter(Boolean);
          if (!dirs.length) throw new Error("dirs is required for scan_new_media.");
          for (const dir of dirs) {
            if (!fs.existsSync(dir)) throw new Error(`Path does not exist: ${dir}`);
          }
          const result = await commands.scanNewMedia(dirs);
          deps.broadcastCatalogChanged?.("assets");
          return result;
        }
        if (action === "list_watched_dirs") {
          if (!deps.watcher) throw new Error("Watcher bridge unavailable.");
          return { dirs: deps.watcher.watchedDirs() };
        }
        if (action === "add_watched_dir" || action === "remove_watched_dir") {
          if (!deps.watcher) throw new Error("Watcher bridge unavailable.");
          if (!args.dir) throw new Error(`dir is required for ${action}.`);
          const dirs = action === "add_watched_dir"
            ? await deps.watcher.addWatchedDir(String(args.dir))
            : await deps.watcher.removeWatchedDir(String(args.dir));
          return { dirs };
        }
        throw new Error(`Unknown action: ${action}`);
      },
    },
    {
      name: "raw_pairing",
      description:
        "Manual RAW↔JPEG pairing. Actions: 'list_pending' — processed images whose RAW match is ambiguous " +
        "(each with candidate RAW assets); 'confirm_match' (image_path, raw_asset_id) — confirm which RAW " +
        "belongs to an image. To register new RAW folders, use import_directory with raw_dirs.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list_pending", "confirm_match"] },
          image_path: { type: "string", description: "For confirm_match" },
          raw_asset_id: { type: "string", description: "For confirm_match" },
        },
        required: ["action"],
      },
      async handler(args) {
        requireCatalog();
        if (args.action === "list_pending") {
          const pending = await commands.listPending();
          return { count: pending.length, pending };
        }
        if (args.action === "confirm_match") {
          if (!args.image_path || !args.raw_asset_id) throw new Error("image_path and raw_asset_id are required.");
          const result = await commands.confirmMatch({ imagePath: String(args.image_path), rawAssetId: String(args.raw_asset_id) });
          deps.broadcastCatalogChanged?.("assets");
          return result;
        }
        throw new Error(`Unknown action: ${args.action}`);
      },
    },
    {
      name: "add_text",
      description:
        "Render a text overlay onto a photo (caption, date stamp, watermark text). Position/size are " +
        "normalized 0-1 (x,y = text center; size = fraction of image height). Handles CJK. Non-destructive: " +
        "the result is a new derived version in the original's version stack. For rich multi-layer layouts " +
        "the user has the app's editor — this is the simple one-line variant.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          text: { type: "string" },
          x: { type: "number", description: "Normalized center x (0-1), default 0.5" },
          y: { type: "number", description: "Normalized center y (0-1), default 0.9" },
          size: { type: "number", description: "Font height as a fraction of image height, default 0.05" },
          color: { type: "string", description: "Hex color, default #FFFFFF" },
          stroke_color: { type: "string", description: "Outline color, default #000000" },
          stroke_width: { type: "number", description: "Outline width in px; default scales with size" },
          opacity: { type: "number", description: "0-1, default 1" },
          align: { type: "string", enum: ["left", "center", "right"] },
        },
        required: ["asset_id", "text"],
      },
      async handler(args) {
        requireCatalog();
        const payload = await commands.addText({
          assetId: String(args.asset_id),
          text: String(args.text),
          x: args.x, y: args.y, size: args.size,
          color: args.color, strokeColor: args.stroke_color, strokeWidth: args.stroke_width,
          opacity: args.opacity, align: args.align,
        });
        rememberPreview(payload.asset_id, null, null);
        deps.broadcastCatalogChanged?.("assets", { ids: [String(args.asset_id)] });
        return {
          source_asset_id: String(args.asset_id),
          new_asset_id: payload.asset_id,
          path: payload.image_path || payload.path,
          thumbnail_url: payload.asset_id ? `http://127.0.0.1:${port}/assets/${payload.asset_id}` : undefined,
        };
      },
    },
    {
      name: "list_tags",
      description: "All tags in the catalog with usage counts — for tag autocomplete and 'what tags exist' questions.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Default all" } },
      },
      async handler(args) {
        requireCatalog();
        const tags = await commands.listTags(args.limit);
        return { count: tags.length, tags };
      },
    },
    {
      name: "generate_previews",
      description:
        "Generate preview thumbnails for specific assets — 'hd' (2000px) before view_assets on detail-critical " +
        "work, or 'standard' (512px) to repair missing/stale thumbnails (force-regenerates).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ["standard", "hd"], description: "Default hd" },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const paths = [];
        for (const id of ids) {
          const detail = await commands.assetDetail({ assetId: id }).catch(() => null);
          if (detail?.image_path) paths.push(detail.image_path);
        }
        if (!paths.length) throw new Error("None of the asset_ids resolved to a file path.");
        const result = args.kind === "standard"
          ? await commands.regeneratePreviews(paths, "preview")
          : await commands.ensureHdPreviews(paths);
        for (const id of ids) previewPathCache.delete(id);
        deps.broadcastCatalogChanged?.("assets", { ids });
        return result;
      },
    },
    {
      name: "get_editor_capabilities",
      description:
        "Enumerations for the rendering tools: frame template ids (apply_frame), collage template ids per " +
        "photo count (render_collage), available fonts and layer types (edit_asset). Call before using those " +
        "tools when you need valid values.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        return await deps.askRenderer("capabilities", {}, { timeoutMs: 15_000 });
      },
    },
    {
      name: "render_collage",
      description:
        "Compose photos into collage pages — the same renderer as the app's collage tool, pixel-identical. " +
        "Without per_page: ONE page from all asset_ids (2-12). With per_page: batch mode — assets are chunked " +
        "into pages of that size. template_id (see get_editor_capabilities) must match the per-page photo " +
        "count; omit it for the default layout. Each page is saved as a new catalog asset linked to its " +
        "source photos. Requires the app window to be open.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          template_id: { type: "string", description: "Collage layout id, e.g. '4-grid'; default first layout for the count" },
          per_page: { type: "number", description: "Batch mode: photos per page (2-12)" },
          ratio: { type: "number", description: "Canvas aspect ratio W/H, default 1 (square)" },
          gap: { type: "number", description: "Gap between cells in export px, default 4" },
          padding: { type: "number", description: "Outer margin in export px, default 0" },
          radius: { type: "number", description: "Cell corner radius in export px, default 0" },
          bg: { type: "string", description: "Background color, default #000000" },
          export_width: { type: "number", description: "Output width in px, default 3000" },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        const catalogPath = requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (ids.length < 2) throw new Error("render_collage needs at least 2 asset_ids.");
        const perPage = args.per_page ? Math.max(1, Math.min(12, Math.round(args.per_page))) : ids.length;
        if (!args.per_page && ids.length > 12) throw new Error("A single page holds at most 12 photos — pass per_page for batch mode.");
        const files = [];
        for (const id of ids) {
          const detail = await commands.assetDetail({ assetId: id });
          if (!detail?.image_path) throw new Error(`No file path for asset ${id}.`);
          files.push({
            assetId: id,
            imagePath: detail.image_path,
            previewPath: detail.image_preview_hd_path || detail.image_preview_path || null,
          });
        }
        const derivedDir = path.join(catalogPath, "derived");
        fs.mkdirSync(derivedDir, { recursive: true });
        const stamp = Date.now();
        const pages = [];
        for (let i = 0; i < files.length; i += perPage) pages.push(files.slice(i, i + perPage));
        // A trailing 1-photo remainder still renders (template "1-full").
        const results = [];
        for (let p = 0; p < pages.length; p++) {
          const page = pages[p];
          const savePath = path.join(derivedDir, `collage_${stamp}_p${p + 1}.jpg`);
          try {
            const out = await deps.askRenderer("collage", {
              files: page,
              templateId: page.length === perPage ? args.template_id || null : null,
              canvasRatio: args.ratio,
              gap: args.gap,
              padding: args.padding,
              borderRadius: args.radius,
              bgColor: args.bg,
              width: args.export_width,
              savePath,
              sourceAssetIds: page.map((f) => f.assetId),
            });
            rememberPreview(out.asset?.asset_id, null, null);
            results.push({
              page: p + 1,
              new_asset_id: out.asset?.asset_id,
              template_id: out.template_id,
              width: out.width,
              height: out.height,
              path: out.saved_path,
              thumbnail_url: out.asset?.asset_id ? `http://127.0.0.1:${port}/assets/${out.asset.asset_id}` : undefined,
            });
          } catch (error) {
            results.push({ page: p + 1, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { pages: results.length, results };
      },
    },
    {
      name: "edit_asset",
      description:
        "Composite edit on one photo using the app's editor pipeline: geometry (crop rect / rotation / flip), " +
        "canvas margins with background color, and overlay layers (text with font/color/outline/glow/shadow, " +
        "sticker from a PNG path). Positions are normalized 0-1; text size is a fraction of image width. " +
        "Non-destructive: the result is a new derived version in the original's version stack. " +
        "Requires the app window to be open. For a plain crop use crop_assets; for one-line text add_text also works.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          geometry: {
            type: "object",
            properties: {
              crop: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } },
              quarter_turns: { type: "number" },
              free_angle: { type: "number" },
              flip_x: { type: "boolean" },
              flip_y: { type: "boolean" },
            },
          },
          canvas: {
            type: "object",
            description: "Optional margins: pad fractions of the photo's short edge, bg color",
            properties: {
              pad: { type: "object", properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } } },
              bg: { type: "string", description: "Margin color, default #ffffff" },
            },
          },
          layers: {
            type: "array",
            description: "Overlay layers, drawn in order. type 'text': {text, x, y, size, font, color, align, bold, italic, rotation, opacity, outline{width,color}, glow{radius,color,opacity}, shadow{x,y,blur,color,opacity}}. type 'sticker': {path, x, y, scale, rotation, opacity}",
            items: { type: "object" },
          },
          format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg" },
        },
        required: ["asset_id"],
      },
      async handler(args) {
        const catalogPath = requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        if (!detail?.image_path) throw new Error(`No file path for asset ${args.asset_id}.`);
        const hasWork = args.geometry || args.canvas || (args.layers || []).length;
        if (!hasWork) throw new Error("Nothing to do — pass geometry, canvas and/or layers.");
        const derivedDir = path.join(catalogPath, "derived");
        fs.mkdirSync(derivedDir, { recursive: true });
        const ext = args.format === "png" ? ".png" : ".jpg";
        const stem = path.basename(detail.image_path).replace(/\.[^.]+$/, "");
        const savePath = path.join(derivedDir, `${stem}_edit_${Date.now()}${ext}`);
        const out = await deps.askRenderer("edit", {
          imagePath: detail.image_path,
          savePath,
          geometry: args.geometry || {},
          canvas: args.canvas || {},
          layers: args.layers || [],
        });
        rememberPreview(out.asset?.asset_id, null, null);
        deps.broadcastCatalogChanged?.("assets", { ids: [String(args.asset_id)] });
        return {
          source_asset_id: String(args.asset_id),
          new_asset_id: out.asset?.asset_id,
          path: out.saved_path,
          thumbnail_url: out.asset?.asset_id ? `http://127.0.0.1:${port}/assets/${out.asset.asset_id}` : undefined,
        };
      },
    },
    {
      name: "apply_frame",
      description:
        "Apply a photo frame / EXIF watermark template (the app's Frame presets: white borders with camera, " +
        "lens and exposure text plus brand logo — e.g. classic bottom bar, polaroid, overlay captions). " +
        "template ids come from get_editor_capabilities frame_templates. EXIF is read from the photo " +
        "automatically. Non-destructive: each result is a new derived version. Requires the app window to be open.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          template: { type: "string", description: "Frame template id" },
        },
        required: ["asset_ids", "template"],
      },
      async handler(args) {
        const catalogPath = requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const derivedDir = path.join(catalogPath, "derived");
        fs.mkdirSync(derivedDir, { recursive: true });
        const results = [];
        for (const id of ids) {
          try {
            const detail = await commands.assetDetail({ assetId: id });
            if (!detail?.image_path) throw new Error("no file path for asset");
            const stem = path.basename(detail.image_path).replace(/\.[^.]+$/, "");
            const savePath = path.join(derivedDir, `${stem}_frame_${Date.now()}.jpg`);
            const out = await deps.askRenderer("frame", {
              imagePath: detail.image_path,
              templateId: String(args.template),
              exifItem: { image_metadata: detail.image_metadata, raw_metadata: detail.raw_metadata },
              savePath,
            });
            rememberPreview(out.asset?.asset_id, null, null);
            results.push({
              source_asset_id: id,
              new_asset_id: out.asset?.asset_id,
              width: out.width,
              height: out.height,
              path: out.saved_path,
              thumbnail_url: out.asset?.asset_id ? `http://127.0.0.1:${port}/assets/${out.asset.asset_id}` : undefined,
            });
          } catch (error) {
            results.push({ source_asset_id: id, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { template: args.template, results };
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
