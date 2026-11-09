// Tools that change assets: metadata, derived versions, exports, deletion.
// Shape and ctx: see tools/index.js.

const os = require("node:os");
const path = require("node:path");
const { thumbnailUrl } = require("./shared");
const { EXPORT_FORMATS, EXPORT_FORMAT_NAMES, exportFormatForTarget } = require("../../../shared/formats.mjs");

module.exports = (ctx) => {
  const { deps, commands, port, requireCatalog, rememberPreview, forgetPreview, derivedOutputDir } = ctx;
  return [
    {
      name: "update_assets",
      description:
        "Batch-edit asset metadata: set star rating (0-5, 0 clears), the pick/reject flag, the description, and/or add/remove tags. " +
        "The app UI refreshes automatically. Tags power search; ratings and flags power filters and smart collections. " +
        "A tag new to the library lands in the group the built-in vocabulary knows it by, else in tag_group if given, else ungrouped; " +
        "an existing tag keeps its group (manage_tags moves it).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          rating: { type: "number", description: "Star rating 0-5; 0 clears the rating" },
          flag: { type: "string", enum: ["pick", "reject", "none"], description: "Pick/reject flag, as Lightroom's P/X/U; none clears it" },
          description: { type: "string", description: "The photo's description, as the user would write it (wins over the AI caption, which annotation never overwrites). An empty string leaves it empty." },
          add_tags: { type: "array", items: { type: "string" } },
          tag_group: { type: "string", description: "With add_tags: the group id (see list_tags) for tags the library does not have yet" },
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
        const hasFlag = args.flag !== undefined && args.flag !== null;
        const hasDescription = typeof args.description === "string";
        if (hasFlag && !["pick", "reject", "none"].includes(args.flag)) throw new Error("flag must be pick, reject or none.");
        if (!hasRating && !hasFlag && !hasDescription && !addTags.length && !removeTags.length) {
          throw new Error("Nothing to do — pass rating, flag, description, add_tags and/or remove_tags.");
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
          if (hasFlag) {
            await commands.setAssetFlag(ids, args.flag);
            mutated = true;
          }
          if (hasDescription) {
            await commands.setAssetDescription(ids, args.description);
            mutated = true;
          }
          // Every new tag onto every photo in one write; ids the catalog
          // doesn't hold come back as missing.
          if (addTags.length) {
            try {
              const added = await commands.addAssetTags(ids, addTags, args.tag_group ? String(args.tag_group) : undefined);
              mutated = true;
              for (const id of added?.missing || []) errors.push({ asset_id: id, op: "add_tags", error: "unknown asset" });
            } catch (error) {
              for (const id of ids) errors.push({ asset_id: id, op: "add_tags", error: error.message });
            }
          }
          // Every tag off every photo in one write.
          if (removeTags.length) {
            try {
              await commands.removeAssetTags(ids, removeTags);
              mutated = true;
            } catch (error) {
              for (const id of ids) errors.push({ asset_id: id, op: "remove_tags", error: error.message });
            }
          }
        } finally {
          // The UI must hear about whatever DID change, even on partial failure.
          if (mutated) deps.broadcastCatalogChanged?.("assets", { ids });
        }
        return {
          updated: ids.length - new Set(errors.map((e) => e.asset_id)).size,
          rating: hasRating ? Number(args.rating) : undefined,
          flag: hasFlag ? args.flag : undefined,
          description: hasDescription ? (args.description.trim() || null) : undefined,
          added_tags: addTags.length ? addTags : undefined,
          removed_tags: removeTags.length ? removeTags : undefined,
          errors: errors.length ? errors : undefined,
        };
      },
    },
    {
      name: "manage_tags",
      description:
        "Tag and tag group management (list_tags shows the current state). Actions: 'create_group' (name, optional ai_fill: whether " +
        "AI annotation may put tags in it, default true); 'rename_group' (group_id, name); 'set_group_ai_fill' (group_id, ai_fill); " +
        "'delete_group' (group_id; its tags become ungrouped); 'move' (tags, group_id or null for ungrouped); 'rename' (tag, name; " +
        "the old spelling stays as an alias); 'merge' (tags → into: every photo keeps one tag, the merged names become aliases); " +
        "'delete' (tag; off every photo); 'pin' (tag, pinned: pinned tags lead every list); 'regroup' (give ungrouped tags the " +
        "built-in vocabulary knows their group). Renames and merges also update smart collections that named the tag. The app UI refreshes automatically.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create_group", "rename_group", "set_group_ai_fill", "delete_group", "move", "rename", "merge", "delete", "pin", "regroup"] },
          group_id: { type: "string", description: "A group id from list_tags; for move, omit or null = ungrouped" },
          name: { type: "string", description: "For create_group / rename_group: the group's name; for rename: the tag's new spelling" },
          ai_fill: { type: "boolean", description: "For create_group / set_group_ai_fill" },
          tags: { type: "array", items: { type: "string" }, description: "For move / merge: the tags to move, or to merge away" },
          tag: { type: "string", description: "For rename / delete / pin" },
          into: { type: "string", description: "For merge: the tag that remains (existing, or a new name)" },
          pinned: { type: "boolean", description: "For pin" },
        },
        required: ["action"],
      },
      async handler(args) {
        requireCatalog();
        const action = args.action;
        const tags = (args.tags || []).map(String).filter(Boolean);
        let result;
        try {
          if (action === "create_group") {
            if (!args.name) throw new Error("name is required for create_group.");
            result = await commands.manageTagGroups({ action: "create", name: String(args.name), aiFill: args.ai_fill !== false });
          } else if (action === "rename_group") {
            if (!args.group_id || !args.name) throw new Error("group_id and name are required for rename_group.");
            result = await commands.manageTagGroups({ action: "rename", group: String(args.group_id), name: String(args.name) });
          } else if (action === "set_group_ai_fill") {
            if (!args.group_id || typeof args.ai_fill !== "boolean") throw new Error("group_id and ai_fill are required for set_group_ai_fill.");
            result = await commands.manageTagGroups({ action: "ai-fill", group: String(args.group_id), aiFill: args.ai_fill });
          } else if (action === "delete_group") {
            if (!args.group_id) throw new Error("group_id is required for delete_group.");
            result = await commands.manageTagGroups({ action: "delete", group: String(args.group_id) });
          } else if (action === "move") {
            if (!tags.length) throw new Error("tags is required for move.");
            result = await commands.setTagGroup(tags, args.group_id ? String(args.group_id) : undefined);
          } else if (action === "rename") {
            if (!args.tag || !args.name) throw new Error("tag and name are required for rename.");
            result = await commands.renameTag(String(args.tag), String(args.name));
          } else if (action === "merge") {
            if (!tags.length || !args.into) throw new Error("tags and into are required for merge.");
            result = await commands.mergeTags(tags, String(args.into));
          } else if (action === "delete") {
            if (!args.tag) throw new Error("tag is required for delete.");
            result = await commands.deleteTag(String(args.tag));
          } else if (action === "pin") {
            if (!args.tag || typeof args.pinned !== "boolean") throw new Error("tag and pinned are required for pin.");
            result = await commands.pinTag(String(args.tag), args.pinned);
          } else if (action === "regroup") {
            result = await commands.regroupTags();
          } else {
            throw new Error(`Unknown action: ${action}`);
          }
        } finally {
          deps.broadcastCatalogChanged?.("tags");
        }
        return result;
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
              // A PNG or WebP stays one; anything else (JPEG, HEIC, TIFF…) is written as JPEG.
              const ext = EXPORT_FORMATS[exportFormatForTarget(src)].extension;
              // Same destination as the sidecar's own derived outputs — never
              // next to the source (that would litter the user's folders).
              const derivedDir = derivedOutputDir();
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
              thumbnail_url: thumbnailUrl(port, payload.asset_id),
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
          format: { type: "string", enum: [...EXPORT_FORMAT_NAMES], description: "Transcode to this format; default keeps original" },
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
        for (const id of ids) forgetPreview(id);
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { deleted: results.length, results };
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
          thumbnail_url: payload.asset_id ? thumbnailUrl(port, payload.asset_id) : undefined,
        };
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
        for (const id of ids) forgetPreview(id);
        deps.broadcastCatalogChanged?.("assets", { ids });
        return result;
      },
    },
  ];
};
