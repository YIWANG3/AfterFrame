// Look-alike photos: the index of perceptual hashes (and, on a Mac, Vision
// feature prints) the visual job keeps for every photo.
// Shape and ctx: see tools/index.js.

module.exports = (ctx) => {
  const { deps, commands, requireCatalog, port, rememberPreview } = ctx;
  const withThumbnail = (row) => {
    if (row.preview_path) rememberPreview(row.asset_id, row.preview_path);
    return { ...row, thumbnail_url: row.preview_path ? `http://127.0.0.1:${port}/assets/${row.asset_id}` : undefined };
  };
  return [
    {
      name: "find_similar",
      description:
        "Photos that look like one, nearest first: another export of the same picture, a crop, the next frame " +
        "of a burst, then the same scene. `distance` is the feature-print distance (under 0.3: the same picture; " +
        "around 0.8: the same scene; above 1: unrelated), `hamming` the perceptual-hash distance (under 8: the " +
        "same picture). Only photos the visual index has seen; run index_lookalikes first on a fresh library.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          limit: { type: "number", description: "Max results, default 24" },
        },
        required: ["asset_id"],
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.findSimilar({ assetId: String(args.asset_id), limit: args.limit });
        return { asset_id: result.asset_id, similar: (result.similar || []).map(withThumbnail) };
      },
    },
    {
      name: "list_lookalikes",
      description:
        "Groups of photos that look the same (re-exports, re-encodes, crops), largest first, with their asset ids. " +
        "Not byte-identical files: get_asset's `duplicates` lists those. The user sees these as the sidebar's Look-alikes.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max groups, default 100" },
          offset: { type: "number" },
        },
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.listLookalikes({ limit: args.limit, offset: args.offset });
        return { group_count: (result.groups || []).length, asset_count: result.asset_count || 0, groups: result.groups || [] };
      },
    },
    {
      name: "index_lookalikes",
      description:
        "Hash every photo the look-alike index has not seen (and, on a Mac, take its Vision feature print). " +
        "The app does this after each import; call it on a library that predates the index, or with force to " +
        "redo all. Returns a job_id to poll with get_job_status.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", description: "Redo photos that already have a hash" },
        },
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startVisualTask) throw new Error("Look-alike indexing unavailable.");
        const status = await deps.startVisualTask({ force: args.force === true });
        // Nothing to do comes back as the last job's snapshot, not running.
        const jobId = status.running ? status.jobId : null;
        if (jobId) deps.broadcastCatalogChanged?.("jobs", { jobId, jobType: "visual" });
        return { job_id: jobId, status: jobId ? status.status : "idle", missing: status.missing || 0 };
      },
    },
  ];
};
