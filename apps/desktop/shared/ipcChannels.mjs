// The desktop bridge's request/response methods, one row each:
//   [method, channel, arity]
// method   the name components call on `api` (src/api/index.js) and the
//          name preload.js exposes on window.mediaWorkspace
// channel  the ipcMain.handle(...) channel that answers it
// arity    how many arguments are forwarded — the old hand-written preload
//          closures had fixed parameter lists, so anything past them was
//          dropped; keep that so a stray extra argument (a DOM event, say)
//          cannot reach structured clone and throw
//
// This is the single place a bridge method is declared. preload.js turns each
// row into a binding at startup (it is sandboxed, so main serves the table
// over app:ipc-methods rather than preload requiring this file), the facade
// generates its entries from it, and two tests hold the rest in line:
//   src/api/apiSurface.test.js     facade / preload / web bridge parity
//   electron/ipcChannels.test.js   every channel here has exactly one handler
// Methods that are not a plain invoke (event subscriptions, sendSync values,
// the one that reshapes its arguments) stay hand-written in preload.js and
// src/api/index.js.
//
// Web build: src/api/browser/bridge.js implements a subset of these names in
// the browser; the parity test only asks that it names nothing else.

export const IPC_METHODS = [
  // ── workspace / catalog ──
  ["getInfo", "workspace:info", 0],
  ["getSummary", "workspace:summary", 0],
  ["getCatalogRoots", "workspace:roots", 0],
  ["registerRoots", "workspace:register-roots", 2],
  ["switchCatalog", "workspace:switch-catalog", 1],
  // ── browse & assets ──
  ["getPending", "workspace:pending", 0],
  ["browseImages", "workspace:browse", 1],
  ["locateImageAsset", "workspace:locate-image-asset", 1],
  ["browseMapPoints", "workspace:browse-map-points", 1],
  ["resolveAiLocations", "workspace:resolve-ai-locations", 0],
  ["discoverCollections", "workspace:discover-collections", 0],
  ["getAssetLocation", "workspace:get-asset-location", 1],
  ["clearAiLocation", "workspace:clear-ai-location", 1],
  ["getFacetValues", "workspace:facet-values", 0],
  ["searchFacet", "workspace:search-facet", 1],
  ["getAssetDetail", "workspace:detail", 1],
  ["getAssetDetailById", "workspace:detail-by-id", 1],
  ["ensureHdPreviews", "workspace:ensure-hd-previews", 1],
  ["regeneratePreviews", "workspace:regenerate-previews", 1],
  ["refreshAssets", "workspace:refresh-assets", 1],
  ["detectEditors", "app:detect-editors", 0],
  ["openInEditor", "app:open-in-editor", 2],
  ["getWatchedDirs", "app:get-watched-dirs", 0],
  ["addWatchedDir", "app:add-watched-dir", 1],
  ["removeWatchedDir", "app:remove-watched-dir", 1],
  ["statDirs", "app:stat-dirs", 1],
  ["verifyAssets", "workspace:verify-assets", 1],
  ["relinkAsset", "workspace:relink-asset", 1],
  ["setLocale", "app:set-locale", 1],
  ["exportSettings", "settings:export", 1],
  ["inspectSettingsImport", "settings:import-inspect", 0],
  ["applySettingsImport", "settings:import-apply", 1],
  ["cancelSettingsImport", "settings:import-cancel", 0],
  ["saveImage", "workspace:save-image", 3],
  ["processAndSave", "workspace:process-and-save", 1],
  ["processAndSavePanels", "workspace:process-and-save-panels", 1],
  ["quickRegister", "workspace:quick-register", 3],
  ["getCollageSources", "workspace:collage-sources", 1],
  ["scanNewMedia", "workspace:scan-new-media", 1],
  ["getFrameLogos", "app:frame-logos", 0],
  ["deleteImageAssets", "workspace:delete-image-assets", 1],
  ["setAssetRating", "workspace:set-asset-rating", 2],
  ["listSystemFonts", "workspace:list-system-fonts", 0],
  ["startNativeDrag", "workspace:native-drag", 1],
  // ── collections ──
  ["reorderCollections", "workspace:reorder-collections", 1],
  ["listCollections", "workspace:list-collections", 0],
  ["createCollection", "workspace:create-collection", 2],
  ["updateCollection", "workspace:update-collection", 2],
  ["deleteCollection", "workspace:delete-collection", 1],
  ["collectionAddItems", "workspace:collection-add-items", 2],
  ["collectionRemoveItems", "workspace:collection-remove-items", 2],
  ["browseCollection", "workspace:browse-collection", 2],
  // ── jobs ──
  ["getImportStatus", "workspace:import-status", 0],
  ["startImport", "workspace:import-start", 1],
  ["getEnrichmentStatus", "workspace:enrichment-status", 0],
  ["startEnrichment", "workspace:enrich-start", 0],
  ["getPreviewStatus", "workspace:preview-status", 0],
  ["startPreviewGeneration", "workspace:preview-start", 1],
  ["getActiveJobs", "workspace:active-jobs", 0],
  ["cancelJob", "workspace:cancel-job", 1],
  ["pauseJob", "workspace:pause-job", 1],
  ["resumeJob", "workspace:resume-job", 1],
  // ── annotation ──
  ["getAnnotationSettings", "workspace:get-annotation-settings", 0],
  ["saveAnnotationSettings", "workspace:save-annotation-settings", 1],
  ["getAnnotationKey", "workspace:get-annotation-key", 1],
  ["setAnnotationKey", "workspace:set-annotation-key", 2],
  ["deleteAnnotationKey", "workspace:delete-annotation-key", 1],
  ["annotateAsset", "workspace:annotate-asset", 1],
  ["startAnnotationJob", "workspace:annotation-start", 1],
  ["getAnnotationJobStatus", "workspace:annotation-status", 0],
  ["countAnnotationTargets", "workspace:annotation-count", 1],
  ["getAnnotation", "workspace:get-annotation", 1],
  ["addAssetTag", "workspace:add-asset-tag", 2],
  ["removeAssetTag", "workspace:remove-asset-tag", 2],
  ["listTags", "workspace:list-tags", 1],
  ["testAnnotationConnection", "workspace:test-annotation-connection", 1],
  ["listAnnotationModels", "workspace:list-annotation-models", 1],
  // ── ai repaint ──
  ["getAiProviderToken", "workspace:get-ai-provider-token", 1],
  ["setAiProviderToken", "workspace:set-ai-provider-token", 2],
  ["deleteAiProviderToken", "workspace:delete-ai-provider-token", 1],
  ["getAiPreferences", "workspace:get-ai-preferences", 0],
  ["saveAiPreferences", "workspace:save-ai-preferences", 1],
  ["getAiRepaintStatus", "workspace:ai-repaint-status", 0],
  ["startAiRepaint", "workspace:ai-repaint-start", 1],
  ["getTextImageStatus", "workspace:text-image-status", 0],
  ["startTextImage", "workspace:text-image-start", 1],
  ["pickHandwritingRef", "workspace:pick-handwriting-ref", 0],
  ["getHandwritingPresetRef", "workspace:handwriting-preset-ref", 1],
  ["listAiModels", "workspace:list-ai-models", 2],
  ["listRepaintHistory", "workspace:list-repaint-history", 1],
  ["getAiStyles", "workspace:get-ai-styles", 0],
  ["saveAiStyles", "workspace:save-ai-styles", 1],
  // ── stickers / depth / misc ──
  ["computeDepth", "workspace:compute-depth", 1],
  ["getDepthModel", "workspace:get-depth-model", 0],
  ["pickDepthModel", "workspace:pick-depth-model", 0],
  ["resetDepthModel", "workspace:reset-depth-model", 0],
  ["getPeopleSettings", "workspace:get-people-settings", 0],
  ["setPeopleAutomaticDownloads", "workspace:set-people-auto-download", 1],
  ["pickPeopleModel", "workspace:pick-people-model", 0],
  ["downloadOfficialPeopleModel", "workspace:download-official-people-model", 0],
  ["setActivePeopleModel", "workspace:set-active-people-model", 1],
  ["removePeopleModel", "workspace:remove-people-model", 1],
  ["startPeopleIndex", "workspace:people-index-start", 1],
  ["getPeopleIndexStatus", "workspace:people-index-status", 0],
  ["listPeopleGroups", "workspace:list-people-groups", 1],
  ["peopleGroupDetail", "workspace:people-group-detail", 1],
  ["similarPeopleGroups", "workspace:similar-people-groups", 1],
  ["renamePeopleGroup", "workspace:rename-people-group", 1],
  ["setPeopleGroupCover", "workspace:set-people-group-cover", 1],
  ["setPeopleGroupState", "workspace:set-people-group-state", 1],
  ["setPeopleGroupsState", "workspace:set-people-groups-state", 1],
  ["mergePeopleGroups", "workspace:merge-people-groups", 1],
  ["removeFaceFromPerson", "workspace:remove-face-from-person", 1],
  ["assignFaceToPerson", "workspace:assign-face-to-person", 1],
  ["stickerList", "workspace:sticker-list", 0],
  ["stickerDetect", "workspace:sticker-detect", 1],
  ["stickerSave", "workspace:sticker-save", 1],
  ["stickerDelete", "workspace:sticker-delete", 1],
  ["stickerToggleStar", "workspace:sticker-toggle-star", 1],
  ["stickerCleanupScratch", "workspace:sticker-cleanup-scratch", 1],
  // ── files & external ──
  ["pickDirectories", "workspace:pick-directories", 1],
  ["createCatalog", "workspace:create-catalog", 0],
  ["pickCatalog", "workspace:pick-catalog", 0],
  ["openSampleCatalog", "workspace:open-sample-catalog", 0],
  ["resetSampleCatalog", "workspace:reset-sample-catalog", 0],
  ["revealPath", "workspace:reveal", 1],
  ["copyText", "app:copy-text", 1],
  ["getMcpStatus", "app:mcp-status", 0],
  ["videoProxy", "app:video-proxy", 1],
  ["videoKeyframes", "app:video-keyframes", 2],
  ["openCacheDir", "app:open-cache-dir", 1],
  ["getPreviewSettings", "app:get-preview-settings", 0],
  ["savePreviewSettings", "app:save-preview-settings", 1],
  ["openExternal", "workspace:open-external", 1],
  ["setTheme", "workspace:set-theme", 1],
  ["pickSavePath", "workspace:pick-save-path", 1],
  ["pickDirectory", "workspace:pick-directory", 1],
];

export const IPC_METHOD_NAMES = IPC_METHODS.map(([method]) => method);
