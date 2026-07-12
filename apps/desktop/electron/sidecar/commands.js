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
    browseImages({ status = "all", limit = 120, offset = 0, search, sort, filters } = {}) {
      const argv = [
        "browse-images",
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

    assetDetail({ assetId, imagePath } = {}) {
      if (assetId) return callJson(["asset-detail", "--asset-id", String(assetId)]);
      return callJson(["asset-detail", "--image-path", String(imagePath)]);
    },

    listPeopleGroups({ state } = {}) {
      const argv = ["list-people-groups"];
      if (state) argv.push("--state", String(state));
      return callJson(argv).then((rows) => rows || []);
    },

    similarPeopleGroups({ groupId, limit } = {}) {
      const argv = ["similar-people-groups", "--group-id", String(groupId)];
      if (limit) argv.push("--limit", String(limit));
      return callJson(argv).then((rows) => rows || []);
    },

    peopleGroupDetail({ groupId, faceLimit, faceOffset } = {}) {
      const argv = ["people-group-detail", "--group-id", String(groupId)];
      if (faceLimit) argv.push("--face-limit", String(faceLimit));
      if (faceOffset) argv.push("--face-offset", String(faceOffset));
      return callJson(argv);
    },

    renamePeopleGroup({ groupId, name } = {}) {
      return callJson(["rename-people-group", "--group-id", String(groupId), "--name", String(name)]);
    },

    setPeopleGroupCover({ groupId, faceId } = {}) {
      return callJson(["set-people-group-cover", "--group-id", String(groupId), "--face-id", String(faceId)]);
    },

    setPeopleGroupState({ groupId, state } = {}) {
      return callJson(["set-people-group-state", "--group-id", String(groupId), "--state", String(state)]);
    },

    setPeopleGroupsState({ groupIds, state } = {}) {
      const argv = ["set-people-groups-state", "--state", String(state)];
      for (const groupId of groupIds || []) argv.push("--group-id", String(groupId));
      return callJson(argv);
    },

    removeFaceFromPerson({ faceId, faceIds } = {}) {
      const ids = faceIds || (faceId ? [faceId] : []);
      const argv = ["remove-face-from-person"];
      for (const id of ids) argv.push("--face-id", String(id));
      return callJson(argv);
    },

    assignFaceToPerson({ faceId, faceIds, groupId } = {}) {
      const ids = faceIds || (faceId ? [faceId] : []);
      const argv = ["assign-face-to-person", "--group-id", String(groupId)];
      for (const id of ids) argv.push("--face-id", String(id));
      return callJson(argv);
    },

    mergePeopleGroups({ sourceGroupId, targetGroupId } = {}) {
      return callJson([
        "merge-people-groups",
        "--source-group-id", String(sourceGroupId),
        "--target-group-id", String(targetGroupId),
      ]);
    },

    // ── Missing-original handling ────────────────────────────────────────
    verifyAssets({ scope = "all" } = {}) {
      return callJson(["verify-assets", "--scope", String(scope)]);
    },

    relinkAsset({ assetId, newPath, force = false } = {}) {
      const argv = ["relink-asset", "--asset-id", String(assetId), "--new-path", String(newPath)];
      if (force) argv.push("--force");
      return callJson(argv);
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

    // On-demand HD (2000px) preview generation scoped to specific source files.
    // Used by the collage editor so cells render/export from HD instead of the
    // 512px thumbnail when the catalog-wide HD pass hasn't run.
    ensureHdPreviews(paths) {
      const argv = ["generate-previews", "--kind", "preview-hd"];
      for (const p of paths) argv.push("--path", String(p));
      return callJson(argv);
    },

    // Force-regenerate 512px thumbnails for specific source files. --force so a
    // stale "ready" entry pointing at a missing/corrupt file is re-rendered.
    regeneratePreviews(paths, kind = "preview") {
      const argv = ["generate-previews", "--kind", String(kind), "--force"];
      for (const p of paths) argv.push("--path", String(p));
      return callJson(argv);
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

    deleteImageAssets(assetIds) {
      const argv = ["delete-image-assets"];
      for (const id of assetIds) argv.push("--asset-id", String(id));
      return callJson(argv).then((rows) => rows || []);
    },

    quickRegister({ imagePath, originPath, collageSourceIds } = {}) {
      const argv = ["quick-register", "--image-path", String(imagePath)];
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
    createJob(jobType, payload, { priority } = {}) {
      const argv = ["create-job", "--job-type", String(jobType), "--payload-json", JSON.stringify(payload || {})];
      if (Number.isFinite(priority)) argv.push("--priority", String(priority));
      return callJson(argv);
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

    pauseJob(jobId) {
      return callJson(["pause-job", "--job-id", String(jobId)]);
    },

    resumeJob(jobId) {
      return callJson(["resume-job", "--job-id", String(jobId)]);
    },
  };
}

module.exports = { createSidecarCommands };
