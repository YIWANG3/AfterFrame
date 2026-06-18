const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("mediaWorkspace", {
  // Resolve the absolute filesystem path of a dropped File (Electron 30+).
  // Gallery drag-and-drop uses this to translate `dataTransfer.files` entries
  // into paths the importer can ingest.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Listen for files dropped on the dock icon / Finder "Open With" / open-files.
  onExternalImport: (callback) => {
    const listener = (_event, paths) => callback(paths);
    ipcRenderer.on("workspace:external-import", listener);
    return () => ipcRenderer.removeListener("workspace:external-import", listener);
  },
  // Agent (MCP) asked the app to reveal assets in the gallery. The renderer
  // answers on a per-request channel so the agent learns what was found.
  onAgentRevealAssets: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:agent-reveal-assets", listener);
    return () => ipcRenderer.removeListener("workspace:agent-reveal-assets", listener);
  },
  sendAgentRevealResult: (requestId, result) =>
    ipcRenderer.send(`workspace:agent-reveal-result:${requestId}`, result),
  // Push selection changes to main so the MCP get_selection tool can answer
  // "these photos" instantly.
  reportSelection: (assets) => ipcRenderer.send("workspace:selection-changed", assets),
  // Agent write tools mutated the catalog — refresh the affected views.
  onCatalogChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:catalog-changed", listener);
    return () => ipcRenderer.removeListener("workspace:catalog-changed", listener);
  },
  isPackaged: ipcRenderer.sendSync("workspace:is-packaged"),
  getInfo: () => ipcRenderer.invoke("workspace:info"),
  getSummary: () => ipcRenderer.invoke("workspace:summary"),
  getCatalogRoots: () => ipcRenderer.invoke("workspace:roots"),
  pickDirectories: (kind) => ipcRenderer.invoke("workspace:pick-directories", kind),
  registerRoots: (rootType, paths) => ipcRenderer.invoke("workspace:register-roots", rootType, paths),
  createCatalog: () => ipcRenderer.invoke("workspace:create-catalog"),
  pickCatalog: () => ipcRenderer.invoke("workspace:pick-catalog"),
  switchCatalog: (catalogPath) => ipcRenderer.invoke("workspace:switch-catalog", catalogPath),
  getImportStatus: () => ipcRenderer.invoke("workspace:import-status"),
  startImport: (options) => ipcRenderer.invoke("workspace:import-start", options),
  getEnrichmentStatus: () => ipcRenderer.invoke("workspace:enrichment-status"),
  startEnrichment: () => ipcRenderer.invoke("workspace:enrich-start"),
  getPreviewStatus: () => ipcRenderer.invoke("workspace:preview-status"),
  startPreviewGeneration: (kind) => ipcRenderer.invoke("workspace:preview-start", kind),
  getActiveJobs: () => ipcRenderer.invoke("workspace:active-jobs"),
  cancelJob: (jobId) => ipcRenderer.invoke("workspace:cancel-job", jobId),
  getPending: () => ipcRenderer.invoke("workspace:pending"),
  browseImages: (options) => ipcRenderer.invoke("workspace:browse", options),
  getFacetValues: () => ipcRenderer.invoke("workspace:facet-values"),
  searchFacet: (options) => ipcRenderer.invoke("workspace:search-facet", options),
  getAssetDetail: (imagePath) => ipcRenderer.invoke("workspace:detail", imagePath),
  getAssetDetailById: (assetId) => ipcRenderer.invoke("workspace:detail-by-id", assetId),
  ensureHdPreviews: (paths) => ipcRenderer.invoke("workspace:ensure-hd-previews", paths),
  detectEditors: () => ipcRenderer.invoke("app:detect-editors"),
  openInEditor: (paths, appPath) => ipcRenderer.invoke("app:open-in-editor", paths, appPath),
  getWatchedDirs: () => ipcRenderer.invoke("app:get-watched-dirs"),
  addWatchedDir: (dir) => ipcRenderer.invoke("app:add-watched-dir", dir),
  removeWatchedDir: (dir) => ipcRenderer.invoke("app:remove-watched-dir", dir),
  statDirs: (paths) => ipcRenderer.invoke("app:stat-dirs", paths),
  onWatchedImport: (callback) => {
    const listener = (_event, paths) => callback(paths);
    ipcRenderer.on("workspace:watched-import", listener);
    return () => ipcRenderer.removeListener("workspace:watched-import", listener);
  },
  revealPath: (targetPath) => ipcRenderer.invoke("workspace:reveal", targetPath),
  copyText: (text) => ipcRenderer.invoke("app:copy-text", text),
  getMediaServerPort: () => { try { return ipcRenderer.sendSync("app:get-media-port"); } catch { return 0; } },
  videoProxy: (originalPath) => ipcRenderer.invoke("app:video-proxy", originalPath),
  videoKeyframes: (originalPath, count) => ipcRenderer.invoke("app:video-keyframes", originalPath, count),
  openCacheDir: (kind) => ipcRenderer.invoke("app:open-cache-dir", kind),
  getPreviewSettings: () => ipcRenderer.invoke("app:get-preview-settings"),
  savePreviewSettings: (next) => ipcRenderer.invoke("app:save-preview-settings", next),
  verifyAssets: (options) => ipcRenderer.invoke("workspace:verify-assets", options),
  relinkAsset: (options) => ipcRenderer.invoke("workspace:relink-asset", options),
  // i18n: synchronous so the first render is already in the right language.
  getInitialLocale: () => { try { return ipcRenderer.sendSync("app:get-locale"); } catch { return "en"; } },
  setLocale: (lng) => ipcRenderer.invoke("app:set-locale", lng),
  openExternal: (url) => ipcRenderer.invoke("workspace:open-external", url),
  pickSavePath: (options) => ipcRenderer.invoke("workspace:pick-save-path", options),
  saveImage: (targetPath, arrayBuffer, sourceMetadataPath) => ipcRenderer.invoke("workspace:save-image", targetPath, arrayBuffer, sourceMetadataPath),
  processAndSave: (options) => ipcRenderer.invoke("workspace:process-and-save", options),
  quickRegister: (imagePath, originPath, collageSourceIds) => ipcRenderer.invoke("workspace:quick-register", imagePath, originPath, collageSourceIds),
  getCollageSources: (assetId) => ipcRenderer.invoke("workspace:collage-sources", assetId),
  deleteImageAssets: (assetIds) => ipcRenderer.invoke("workspace:delete-image-assets", assetIds),
  getAiProviderToken: (provider) => ipcRenderer.invoke("workspace:get-ai-provider-token", provider),
  setAiProviderToken: (provider, token) => ipcRenderer.invoke("workspace:set-ai-provider-token", provider, token),
  deleteAiProviderToken: (provider) => ipcRenderer.invoke("workspace:delete-ai-provider-token", provider),
  getAiPreferences: () => ipcRenderer.invoke("workspace:get-ai-preferences"),
  saveAiPreferences: (prefs) => ipcRenderer.invoke("workspace:save-ai-preferences", prefs),
  // LLM auto-annotation
  getAnnotationSettings: () => ipcRenderer.invoke("workspace:get-annotation-settings"),
  saveAnnotationSettings: (next) => ipcRenderer.invoke("workspace:save-annotation-settings", next),
  getAnnotationKey: (provider) => ipcRenderer.invoke("workspace:get-annotation-key", provider),
  setAnnotationKey: (provider, token) => ipcRenderer.invoke("workspace:set-annotation-key", provider, token),
  deleteAnnotationKey: (provider) => ipcRenderer.invoke("workspace:delete-annotation-key", provider),
  annotateAsset: (options) => ipcRenderer.invoke("workspace:annotate-asset", options),
  startAnnotationJob: (options) => ipcRenderer.invoke("workspace:annotation-start", options),
  getAnnotationJobStatus: () => ipcRenderer.invoke("workspace:annotation-status"),
  countAnnotationTargets: (options) => ipcRenderer.invoke("workspace:annotation-count", options),
  getAnnotation: (assetId) => ipcRenderer.invoke("workspace:get-annotation", assetId),
  addAssetTag: (assetId, tag) => ipcRenderer.invoke("workspace:add-asset-tag", assetId, tag),
  removeAssetTag: (assetId, tag) => ipcRenderer.invoke("workspace:remove-asset-tag", assetId, tag),
  listTags: (limit) => ipcRenderer.invoke("workspace:list-tags", limit),
  testAnnotationConnection: (options) => ipcRenderer.invoke("workspace:test-annotation-connection", options),
  listAnnotationModels: (options) => ipcRenderer.invoke("workspace:list-annotation-models", options),
  getAiRepaintStatus: () => ipcRenderer.invoke("workspace:ai-repaint-status"),
  startAiRepaint: (options) => ipcRenderer.invoke("workspace:ai-repaint-start", options),
  listAiModels: (providerId, providerType) => ipcRenderer.invoke("workspace:list-ai-models", providerId, providerType),
  listRepaintHistory: (assetPath) => ipcRenderer.invoke("workspace:list-repaint-history", assetPath),
  getAiStyles: () => ipcRenderer.invoke("workspace:get-ai-styles"),
  saveAiStyles: (styles) => ipcRenderer.invoke("workspace:save-ai-styles", styles),
  listCollections: () => ipcRenderer.invoke("workspace:list-collections"),
  createCollection: (name, kind) => ipcRenderer.invoke("workspace:create-collection", name, kind),
  updateCollection: (collectionId, updates) => ipcRenderer.invoke("workspace:update-collection", collectionId, updates),
  deleteCollection: (collectionId) => ipcRenderer.invoke("workspace:delete-collection", collectionId),
  collectionAddItems: (collectionId, assetIds) => ipcRenderer.invoke("workspace:collection-add-items", collectionId, assetIds),
  collectionRemoveItems: (collectionId, assetIds) => ipcRenderer.invoke("workspace:collection-remove-items", collectionId, assetIds),
  setAssetRating: (assetIds, rating) => ipcRenderer.invoke("workspace:set-asset-rating", assetIds, rating),
  browseCollection: (collectionId, options) => ipcRenderer.invoke("workspace:browse-collection", collectionId, options),
  listSystemFonts: () => ipcRenderer.invoke("workspace:list-system-fonts"),
  computeDepth: (options) => ipcRenderer.invoke("workspace:compute-depth", options),
  getDepthModel: () => ipcRenderer.invoke("workspace:get-depth-model"),
  pickDepthModel: () => ipcRenderer.invoke("workspace:pick-depth-model"),
  resetDepthModel: () => ipcRenderer.invoke("workspace:reset-depth-model"),
  // Sticker extraction & library
  stickerList: () => ipcRenderer.invoke("workspace:sticker-list"),
  stickerDetect: (options) => ipcRenderer.invoke("workspace:sticker-detect", options),
  stickerSave: (options) => ipcRenderer.invoke("workspace:sticker-save", options),
  stickerDelete: (id) => ipcRenderer.invoke("workspace:sticker-delete", id),
  stickerToggleStar: (id) => ipcRenderer.invoke("workspace:sticker-toggle-star", id),
  stickerCleanupScratch: (dir) => ipcRenderer.invoke("workspace:sticker-cleanup-scratch", dir),
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("workspace:menu-action", listener);
    return () => ipcRenderer.removeListener("workspace:menu-action", listener);
  },
});
