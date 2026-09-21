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
    locateImageAsset({ assetId, status = "all", collectionId, search, sort, filters } = {}) {
      const argv = ["locate-image-asset", "--asset-id", String(assetId), "--status", String(status)];
      if (collectionId) argv.push("--collection-id", String(collectionId));
      if (search) argv.push("--search", String(search));
      if (sort) argv.push("--sort", String(sort));
      if (filters && Object.keys(filters).length) argv.push("--filters", JSON.stringify(filters));
      return callJson(argv);
    },
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

    // Lightweight location points for the map. Mirrors the gallery scope
    // (status/collection/search/facets); the sidecar ignores filters.geo so
    // the map keeps showing clusters outside the current viewport.
    browseMapPoints({ status = "all", collectionId, search, filters, minPrecision, limit = 100000 } = {}) {
      const argv = ["browse-map-points", "--limit", String(limit)];
      if (collectionId) argv.push("--collection-id", String(collectionId));
      else argv.push("--status", String(status));
      if (search) argv.push("--search", String(search));
      if (filters && Object.keys(filters).length) argv.push("--filters", JSON.stringify(filters));
      if (minPrecision) argv.push("--min-precision", String(minPrecision));
      return callJson(argv).then((rows) => rows || []);
    },

    setAssetLocation({ assetId, lat, lng, clear = false } = {}) {
      const argv = ["set-asset-location", "--asset-id", String(assetId)];
      if (clear) argv.push("--clear");
      else argv.push("--lat", String(lat), "--lng", String(lng));
      return callJson(argv);
    },

    clearAiLocation(assetId) {
      return callJson(["clear-ai-location", "--asset-id", String(assetId)]);
    },

    // Discover page collections: located assets grouped into places and
    // memories (one visit to a place). Read-only, computed from map points.
    discoverCollections() {
      return callJson(["discover-collections"]).then((out) => out || { places: [], memories: [] });
    },

    // One-shot backfill: resolve existing AI annotations' location guesses
    // into asset_locations (offline gazetteer). New annotations resolve at
    // save time in the sidecar; this covers pre-existing ones.
    resolveAiLocations() {
      return callJson(["resolve-ai-locations"]);
    },

    // Effective location of one image asset (RAW-first, no precision floor).
    // Null when the asset has neither GPS nor a resolved AI location.
    getAssetLocation(assetId) {
      return callJson(["get-asset-location", "--asset-id", String(assetId)]);
    },

    // A folder takes the same search text and facet filters the library does.
    browseCollection(collectionId, { limit = 120, offset = 0, search, filters } = {}) {
      const argv = [
        "browse-collection",
        "--collection-id", String(collectionId),
        "--limit", String(limit),
        "--offset", String(offset),
      ];
      if (search) argv.push("--search", String(search));
      if (filters && Object.keys(filters).length) argv.push("--filters", JSON.stringify(filters));
      return callJson(argv).then((rows) => rows || []);
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

    // collectionId: describe that folder (options and counts) instead of the library.
    facetValues({ collectionId } = {}) {
      const argv = ["facet-values"];
      if (collectionId) argv.push("--collection-id", String(collectionId));
      return callJson(argv);
    },

    searchFacet({ field, q = "", limit, collectionId } = {}) {
      const argv = ["search-facet", "--field", String(field)];
      if (q) argv.push("--q", String(q));
      if (limit) argv.push("--limit", String(limit));
      if (collectionId) argv.push("--collection-id", String(collectionId));
      return callJson(argv).then((rows) => rows || []);
    },

    listPending() {
      return callJson(["list-pending"]).then((rows) => rows || []);
    },

    confirmMatch({ imagePath, rawAssetId } = {}) {
      return callJson(["confirm-match", "--image-path", String(imagePath), "--raw-asset-id", String(rawAssetId)]);
    },

    scanNewMedia(imageDirs) {
      const argv = ["scan-new-media"];
      for (const dir of imageDirs || []) argv.push("--image-dir", String(dir));
      return callJson(argv);
    },

    catalogRoots() {
      return callJson(["catalog-roots"]).then((rows) => rows || []);
    },

    summary() {
      return callJson(["summary", "--json"]);
    },

    // Startup migrations for catalogs written by older builds. Both are
    // idempotent; callers treat failure as best-effort.
    splitSharedAssets() {
      return callJson(["split-shared-assets"]);
    },

    repairResourceSets() {
      return callJson(["repair-resource-sets"]);
    },

    // Legacy token store inside the catalog DB, read once to migrate into the
    // app's keychain-backed settings.
    getProviderToken(provider) {
      return callJson(["get-provider-token", "--provider", String(provider)]);
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

    // Re-read source metadata and force-regenerate previews for existing assets.
    // The sidecar also refreshes an HD tier when that asset already has one.
    refreshAssets(paths) {
      const argv = ["refresh-assets"];
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

    reorderCollections(collectionIds) {
      return callJson(["reorder-collections", ...collectionIds.flatMap((id) => ["--collection-id", String(id)])]);
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

    // Pillow-rendered text overlay → derived version (the one renderer-
    // independent compositor in the sidecar). Coordinates are normalized 0-1.
    addText({ assetId, text, x, y, size, color, strokeColor, strokeWidth, opacity, align, fontPath } = {}) {
      const argv = ["add-text", "--asset-id", String(assetId), "--text", String(text)];
      if (x != null) argv.push("--x", String(x));
      if (y != null) argv.push("--y", String(y));
      if (size != null) argv.push("--size", String(size));
      if (color) argv.push("--color", String(color));
      if (strokeColor) argv.push("--stroke-color", String(strokeColor));
      if (strokeWidth != null) argv.push("--stroke-width", String(strokeWidth));
      if (opacity != null) argv.push("--opacity", String(opacity));
      if (align) argv.push("--align", String(align));
      if (fontPath) argv.push("--font-path", String(fontPath));
      return callJson(argv);
    },

    listRepaintHistory(assetPath) {
      return callJson(["list-repaint-history", "--asset-path", String(assetPath)]).then((rows) => rows || []);
    },

    // Collage provenance: the source assets of a collage and the collages an
    // asset appears in.
    collageSources(assetId) {
      return callJson(["collage-sources", "--asset-id", String(assetId)]);
    },

    // ── AI providers / annotation ────────────────────────────────────────
    // apiKey rides on argv only until the transport strips it into the
    // environment (see sidecar/transport.js extractSecretEnv).
    listAiModels({ providerType, apiKey, baseUrl } = {}) {
      const argv = ["list-ai-models", "--provider", String(providerType), "--api-key", String(apiKey)];
      if (baseUrl) argv.push("--base-url", String(baseUrl));
      return callJson(argv).then((rows) => rows || []);
    },

    annotateAsset({
      assetId, imagePath, provider, model, apiKey, baseUrl,
      languages, maxTags, maxCaptionChars, customInstructions, hint,
    } = {}) {
      const argv = [
        "annotate-asset",
        "--asset-id", String(assetId),
        "--image", String(imagePath),
        "--provider", String(provider),
        "--model", String(model),
      ];
      if (apiKey) argv.push("--api-key", apiKey);
      if (baseUrl) argv.push("--base-url", String(baseUrl));
      if (Array.isArray(languages) && languages.length) argv.push("--languages", languages.join(","));
      if (Number.isFinite(maxTags)) argv.push("--max-tags", String(maxTags));
      if (Number.isFinite(maxCaptionChars)) argv.push("--max-caption-chars", String(maxCaptionChars));
      if (customInstructions) argv.push("--custom-instructions", String(customInstructions));
      if (hint) argv.push("--hint", String(hint));
      return callJson(argv);
    },

    // How many assets a batch annotation would touch, before starting it.
    annotationCount({ onlyMissing = true, assetIds, collectionId } = {}) {
      const argv = ["annotation-count"];
      if (onlyMissing === false) argv.push("--reannotate");
      const ids = Array.isArray(assetIds) ? assetIds.filter(Boolean) : [];
      if (ids.length) argv.push("--asset-ids", ids.join(","));
      if (collectionId) argv.push("--collection-id", String(collectionId));
      return callJson(argv).then((res) => res || { count: 0 });
    },

    // Catalog-free: these run before any catalog is open (Settings → AI).
    annotationTestConnection({ provider, apiKey, baseUrl } = {}) {
      const argv = ["annotation-test-connection", "--provider", String(provider)];
      if (apiKey) argv.push("--api-key", apiKey);
      if (baseUrl) argv.push("--base-url", String(baseUrl));
      return callJson(argv);
    },

    annotationListModels({ provider, apiKey, baseUrl } = {}) {
      const argv = ["annotation-list-models", "--provider", String(provider)];
      if (apiKey) argv.push("--api-key", apiKey);
      if (baseUrl) argv.push("--base-url", String(baseUrl));
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
