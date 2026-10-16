// Library-level tools: collections, importing, housekeeping, RAW pairing.
// Shape and ctx: see tools/index.js.

const fs = require("node:fs");
const { compactAsset, smartRulesFrom } = require("./shared");

const IMPORT_WAIT_MS = 25000;

module.exports = (ctx) => {
  const { deps, commands, port, getCatalogState, startImportTask, formatJobStatus, registerRoots, requireCatalog, rememberPreview } = ctx;
  return [
    {
      name: "manage_collections",
      description:
        "Collections management. Two kinds: a folder holds photos you add to it; a SMART collection is a saved " +
        "filter that fills itself and stays current (e.g. 5-star photos from the last 30 days). " +
        "Actions: 'list' all collections (smart ones include their rules and live item_count; folders also carry " +
        "last_added_at, captured_from / captured_to — the capture-time span of their photos — and cover_preview_paths, " +
        "the previews of the newest four photos); 'create' (name; " +
        "pass rules to make it smart); 'update_rules' (collection_id, rules) to change a smart collection's " +
        "conditions; 'rename' (collection_id, name); 'delete' (collection_id); 'add_items' / 'remove_items' " +
        "(collection_id, asset_ids; folders only); 'browse' (collection_id, limit/offset) to list the assets of either kind.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "update_rules", "rename", "delete", "add_items", "remove_items", "browse"] },
          rules: {
            type: "object",
            description: "Smart collection conditions, AND-combined. At least one is required. Same names and meanings as " +
              "search_assets (camera, lens, tag, extension, country and city take one value or a list meaning any of them; tag_match: 'all' requires every tag): query, status, camera, lens, iso_min/max, aperture_min/max, focal_min/max, shutter_min/max, " +
              "date_from, date_to, date_within_days, rating_min, rating_max (0 = unrated), flag (pick | reject | none), orientation, tag, asset_type, extension, people, person_id, annotated, location_source, country, city, color, color_tolerance, caption_contains, ocr_contains, path_contains, " +
              "collection_id ('only photos in that folder'); " +
              "exclude (a list of those condition names to turn into their opposite: exclude ['collection_id'] = not in that folder); " +
              "any_of (a list of groups of the same conditions, at least one of which must hold: OR).",
          },
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
        const needsId = ["update_rules", "rename", "delete", "add_items", "remove_items", "browse"];
        if (needsId.includes(action) && !args.collection_id) throw new Error(`collection_id is required for ${action}.`);
        if (action === "list") {
          return { collections: await commands.listCollections() };
        }
        if (action === "create") {
          if (!args.name) throw new Error("name is required for create.");
          const created = args.rules
            ? await commands.createCollection(String(args.name), "smart", smartRulesFrom(args.rules))
            : await commands.createCollection(String(args.name), "manual");
          deps.broadcastCatalogChanged?.("collections");
          return created;
        }
        if (action === "update_rules") {
          const updated = await commands.updateCollection(String(args.collection_id), { rules: smartRulesFrom(args.rules) });
          deps.broadcastCatalogChanged?.("collections");
          return updated;
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
          // A smart collection has no members to list: browsing it is running its saved filter.
          const smart = (await commands.listCollections()).find((c) => c.collection_id === String(args.collection_id) && c.kind === "smart");
          if (smart && !smart.rules) throw new Error("This smart collection's rules cannot be read by this version of AfterFrame.");
          const page = { limit: args.limit || 24, offset: args.offset || 0 };
          const rows = smart
            ? await commands.browseImages({ status: "all", base: smart.rules, ...page })
            : await commands.browseCollection(String(args.collection_id), page);
          for (const row of rows) rememberPreview(row.asset_id, row.preview_path, row.preview_hd_path);
          return { count: rows.length, assets: rows.map((row) => compactAsset(row, port)) };
        }
        throw new Error(`Unknown action: ${action}`);
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
        // rejectIfBusy: with an import already running, startImportTask would
        // hand back THAT job and silently drop these dirs — the tool would then
        // poll a stranger's job and report success for an import that never ran.
        let status = await startImportTask({ mode, rawDirs, imageDirs, rejectIfBusy: true });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "import" });
        const deadline = Date.now() + IMPORT_WAIT_MS;
        while (status.running && status.jobId && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          status = formatJobStatus(await commands.getJob(status.jobId));
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
  ];
};
