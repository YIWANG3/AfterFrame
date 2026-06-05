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
    ipcRenderer.removeAllListeners("workspace:external-import");
    ipcRenderer.on("workspace:external-import", (_event, paths) => callback(paths));
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
  getPending: () => ipcRenderer.invoke("workspace:pending"),
  browseExports: (options) => ipcRenderer.invoke("workspace:browse", options),
  getFacetValues: () => ipcRenderer.invoke("workspace:facet-values"),
  getAssetDetail: (exportPath) => ipcRenderer.invoke("workspace:detail", exportPath),
  getAssetDetailById: (assetId) => ipcRenderer.invoke("workspace:detail-by-id", assetId),
  revealPath: (targetPath) => ipcRenderer.invoke("workspace:reveal", targetPath),
  openExternal: (url) => ipcRenderer.invoke("workspace:open-external", url),
  pickSavePath: (options) => ipcRenderer.invoke("workspace:pick-save-path", options),
  saveImage: (targetPath, arrayBuffer, sourceMetadataPath) => ipcRenderer.invoke("workspace:save-image", targetPath, arrayBuffer, sourceMetadataPath),
  processAndSave: (options) => ipcRenderer.invoke("workspace:process-and-save", options),
  quickRegister: (exportPath, originPath, collageSourceIds) => ipcRenderer.invoke("workspace:quick-register", exportPath, originPath, collageSourceIds),
  getCollageSources: (assetId) => ipcRenderer.invoke("workspace:collage-sources", assetId),
  deleteExportAssets: (assetIds) => ipcRenderer.invoke("workspace:delete-export-assets", assetIds),
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
    ipcRenderer.removeAllListeners("workspace:menu-action");
    ipcRenderer.on("workspace:menu-action", (_event, action) => callback(action));
  },
});
