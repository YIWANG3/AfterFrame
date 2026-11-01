// Read-only tools: what is in the catalog and what it looks like.
// Shape and ctx: see tools/index.js.

const fs = require("node:fs");
const { ANY_OF_ARG, EXCLUDE_ARG, ONE_OR_MANY, compactAsset, facetFiltersFrom, nearToBounds } = require("./shared");

const VIEW_MAX_ASSETS = 8;
const VIEW_EDGE_PX = 384;
const VIEW_TIME_BUDGET_MS = 20000;

module.exports = (ctx) => {
  const { commands, port, requireCatalog, rememberPreview, resolvePreviewPaths, sharp } = ctx;
  return [
    {
      name: "get_catalog_info",
      description:
        "Overview of the currently open AfterFrame catalog: path, asset counts, and available search facets " +
        "(camera models, lens models, ISO/aperture/focal ranges, capture-time span). " +
        "Call this first to learn what values are valid for search_assets filters.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const catalogPath = requireCatalog();
        const [summary, facets] = await Promise.all([
          commands.summary(),
          commands.facetValues().catch(() => null),
        ]);
        return { catalog_path: catalogPath, summary, facets };
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
          similar_to: { type: "string", description: "An asset id: that photo first, then the ones that look like it, nearest first (the look-alike index; see find_similar). Sort is ignored." },
          query: { type: "string", description: "Free-text search across name, path, camera, lens, caption, OCR text, tags" },
          status: { type: "string", enum: ["all", "matched", "unmatched", "rated", "recent"], description: "Asset subset; 'recent' = imported in the last 7 days. Default all" },
          sort: { type: "string", enum: ["name-asc", "name-desc", "imported-desc", "imported-asc", "captured-desc", "captured-asc", "rating-desc"], description: "Default name-asc" },
          limit: { type: "number", description: "Max results, default 24" },
          offset: { type: "number" },
          camera: { ...ONE_OR_MANY, description: "Exact camera model (see get_catalog_info facets). A list means any of them." },
          lens: { ...ONE_OR_MANY, description: "Exact lens model. A list means any of them." },
          iso_min: { type: "number" },
          iso_max: { type: "number" },
          aperture_min: { type: "number" },
          aperture_max: { type: "number" },
          focal_min: { type: "number", description: "Focal length lower bound (mm)" },
          focal_max: { type: "number" },
          date_from: { type: "string", description: "Capture date lower bound, ISO format e.g. 2026-05-01" },
          date_to: { type: "string" },
          date_within_days: { type: "number", description: "Captured in the last N days (relative to today)" },
          rating_min: { type: "number", description: "Minimum star rating 1-5" },
          rating_max: { type: "number", description: "Maximum star rating 0-5; 0 means unrated. With rating_min equal to it: exactly that many stars" },
          flag: {
            anyOf: [{ type: "string", enum: ["pick", "reject", "none"] }, { type: "array", items: { type: "string", enum: ["pick", "reject", "none"] } }],
            description: "Pick/reject flag (Lightroom's P/X/U): pick, reject, or none (unflagged). A list means any of them.",
          },
          orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
          tag: { ...ONE_OR_MANY, description: "Exact tag match. A list means any of them." },
          location_source: {
            anyOf: [{ type: "string", enum: ["exif", "ai", "manual", "none"] }, { type: "array", items: { type: "string", enum: ["exif", "ai", "manual", "none"] } }],
            description: "What the photo's location is based on: exif (GPS), ai (guessed from the image), manual, or none (no location yet). A list means any of them.",
          },
          country: { ...ONE_OR_MANY, description: "Country or region the photo was taken in, as an ISO 3166-1 alpha-2 code (JP, US, FR, HK). Works for GPS, AI-guessed and manual locations alike. A list means any of them." },
          city: { ...ONE_OR_MANY, description: "City the photo was taken in, by its English name as in the offline gazetteer (Tokyo, New York City, Paris). A list means any of them." },
          color: { ...ONE_OR_MANY, description: "A colour the photo must contain, as hex (#3a7bd5): matches photos with a dominant colour near it. A list means any of them." },
          color_tolerance: { type: "string", enum: ["strict", "normal", "loose"], description: "How close a photo's colour must be to `color` (default normal)." },
          caption_contains: { type: "string", description: "Text the AI description must contain (that field only, unlike query)" },
          ocr_contains: { type: "string", description: "Text that must appear IN the picture (signs, labels), as read by AI annotation" },
          path_contains: { type: "string", description: "Text the file's folder or name must contain" },
          tag_match: { type: "string", enum: ["any", "all"], description: "With several tags: any of them (default) or all of them" },
          asset_type: { type: "string", enum: ["image", "video", "raw"], description: "Only photos, only videos, or only RAW files" },
          extension: { ...ONE_OR_MANY, description: "File format, as a family ('jpeg' = .jpg/.jpeg/.jfif…, 'heif' = .heic/.heif/.hif, 'tiff', 'png', 'mp4', 'cr3', 'arw'; the values get_facet_values lists) or one extension ('jpg', 'hif'). A list means any of them." },
          shutter_min: { type: "number", description: "Shutter speed lower bound in seconds (e.g. 0.001 for 1/1000s)" },
          shutter_max: { type: "number" },
          people: { type: "string", enum: ["with_faces", "without_faces"], description: "Filter by detected faces" },
          person_id: { type: "string", description: "Only photos of this person (a people group id from list_people)" },
          annotated: { type: "string", enum: ["with", "without"], description: "Whether AI annotation exists" },
          collection_id: { type: "string", description: "Only photos in this folder (a manual collection from manage_collections)" },
          exclude: EXCLUDE_ARG,
          any_of: ANY_OF_ARG,
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
        const filters = facetFiltersFrom(args);
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
          similarTo: args.similar_to ? String(args.similar_to) : undefined,
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
  ];
};
