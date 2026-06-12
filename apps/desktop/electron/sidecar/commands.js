// The single place that knows how to build sidecar CLI argv. Both the IPC
// handlers (electron/ipc/*.js) and the MCP tools (electron/mcp/server.js)
// call these — previously each surface hand-built the same commands and the
// two had already drifted (see docs/review-2026-06.md P3-3).
//
// Functions are thin: argv assembly + result normalization only. Transport,
// catalog binding and secrets handling stay in main.js's call layer.

function createSidecarCommands(callJson) {
  return {
    // ── Browse / read ────────────────────────────────────────────────────
    browseExports({ status = "all", limit = 120, offset = 0, search, sort, filters } = {}) {
      const argv = [
        "browse-exports",
        "--status", String(status),
        "--limit", String(limit),
        "--offset", String(offset),
      ];
      if (search) argv.push("--search", String(search));
      if (sort) argv.push("--sort", String(sort));
      if (filters && Object.keys(filters).length) argv.push("--filters", JSON.stringify(filters));
      return callJson(argv).then((rows) => rows || []);
    },

    browseCollection(collectionId, { limit = 120, offset = 0 } = {}) {
      return callJson([
        "browse-collection",
        "--collection-id", String(collectionId),
        "--limit", String(limit),
        "--offset", String(offset),
      ]).then((rows) => rows || []);
    },

    assetDetail({ assetId, exportPath } = {}) {
      if (assetId) return callJson(["asset-detail", "--asset-id", String(assetId)]);
      return callJson(["asset-detail", "--export-path", String(exportPath)]);
    },

    facetValues() {
      return callJson(["facet-values"]);
    },

    searchFacet({ field, q = "", limit } = {}) {
      const argv = ["search-facet", "--field", String(field)];
      if (q) argv.push("--q", String(q));
      if (limit) argv.push("--limit", String(limit));
      return callJson(argv).then((rows) => rows || []);
    },

    listPending() {
      return callJson(["list-pending"]).then((rows) => rows || []);
    },

    catalogRoots() {
      return callJson(["catalog-roots"]).then((rows) => rows || []);
    },

    registerRoots(rootType, paths) {
      const argv = ["register-roots", "--root-type", String(rootType)];
      for (const p of paths) argv.push("--path", String(p));
      return callJson(argv).then((rows) => rows || []);
    },

    // ── Collections ──────────────────────────────────────────────────────
    listCollections() {
      return callJson(["list-collections"]).then((rows) => rows || []);
    },

    createCollection(name, kind = "manual") {
      return callJson(["create-collection", "--name", String(name), "--kind", String(kind)]);
    },

    updateCollection(collectionId, { name, rulesJson, sortOrder } = {}) {
      const argv = ["update-collection", "--collection-id", String(collectionId)];
      if (name != null) argv.push("--name", String(name));
      if (rulesJson != null) argv.push("--rules-json", String(rulesJson));
      if (sortOrder != null) argv.push("--sort-order", String(sortOrder));
      return callJson(argv);
    },

    deleteCollection(collectionId) {
      return callJson(["delete-collection", "--collection-id", String(collectionId)]);
    },

    collectionAddItems(collectionId, assetIds) {
      const argv = ["collection-add-items", "--collection-id", String(collectionId)];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      return callJson(argv);
    },

    collectionRemoveItems(collectionId, assetIds) {
      const argv = ["collection-remove-items", "--collection-id", String(collectionId)];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      return callJson(argv);
    },

    // ── Asset mutations ──────────────────────────────────────────────────
    setAssetRating(assetIds, rating) {
      const argv = ["set-asset-rating", "--rating", String(rating)];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      return callJson(argv);
    },

    addAssetTag(assetId, tag) {
      return callJson(["add-asset-tag", "--asset-id", String(assetId), "--tag", String(tag)]);
    },

    removeAssetTag(assetId, tag) {
      return callJson(["remove-asset-tag", "--asset-id", String(assetId), "--tag", String(tag)]);
    },

    listTags(limit) {
      const argv = ["list-tags"];
      if (limit) argv.push("--limit", String(limit));
      return callJson(argv).then((rows) => rows || []);
    },

    getAnnotation(assetId) {
      return callJson(["get-annotation", "--asset-id", String(assetId)]);
    },

    deleteExportAssets(assetIds) {
      const argv = ["delete-export-assets"];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      return callJson(argv).then((rows) => rows || []);
    },

    quickRegister({ exportPath, originPath, collageSourceIds } = {}) {
      const argv = ["quick-register", "--export-path", String(exportPath)];
      if (originPath) argv.push("--origin-path", String(originPath));
      if (Array.isArray(collageSourceIds) && collageSourceIds.length) {
        argv.push("--collage-source-ids", ...collageSourceIds.map(String));
      }
      return callJson(argv);
    },

    // ── Derived / export ─────────────────────────────────────────────────
    createDerived({ assetId, ratio, gravity = "center" } = {}) {
      return callJson([
        "create-derived",
        "--asset-id", String(assetId),
        "--crop-ratio", String(ratio),
        "--gravity", String(gravity),
      ]);
    },

    exportAssets({ assetIds, dest, maxEdge, format, quality } = {}) {
      const argv = ["export-assets", "--dest", String(dest)];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      if (maxEdge) argv.push("--max-edge", String(maxEdge));
      if (format) argv.push("--format", String(format));
      if (quality) argv.push("--quality", String(quality));
      return callJson(argv).then((rows) => rows || []);
    },

    // ── Jobs ─────────────────────────────────────────────────────────────
    createJob(jobType, payload) {
      return callJson(["create-job", "--job-type", String(jobType), "--payload-json", JSON.stringify(payload || {})]);
    },

    getJob(jobId) {
      return callJson(["get-job", "--job-id", String(jobId)]);
    },

    latestJob(jobType) {
      const argv = ["latest-job"];
      if (jobType) argv.push("--job-type", String(jobType));
      return callJson(argv);
    },

    listActiveJobs() {
      return callJson(["list-active-jobs"]).then((rows) => rows || []);
    },

    cancelJob(jobId) {
      return callJson(["cancel-job", "--job-id", String(jobId)]);
    },
  };
}

module.exports = { createSidecarCommands };
