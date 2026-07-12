// Flat facade over the preload bridge, grouped by domain. Method names match
// preload.js 1:1 so call sites migrate mechanically; renames later only touch
// this file. New preload methods MUST be added here (greppable inventory).

import { invoke, bridge } from "./client";

const api = {
  get isPackaged() { return bridge().isPackaged; },
  // Capability check — facade methods always exist, so guards that previously
  // tested `window.mediaWorkspace?.method` must ask the bridge instead.
  has: (method) => typeof bridge()[method] === "function",


  // ── files & external ──
  getPathForFile: (...args) => invoke("getPathForFile", ...args),
  revealPath: (...args) => invoke("revealPath", ...args),
  copyText: (...args) => invoke("copyText", ...args),
  videoProxy: (...args) => invoke("videoProxy", ...args),
  videoKeyframes: (...args) => invoke("videoKeyframes", ...args),
  openCacheDir: (...args) => invoke("openCacheDir", ...args),
  getPreviewSettings: (...args) => invoke("getPreviewSettings", ...args),
  savePreviewSettings: (...args) => invoke("savePreviewSettings", ...args),
  openExternal: (...args) => invoke("openExternal", ...args),
  pickSavePath: (...args) => invoke("pickSavePath", ...args),
  pickDirectories: (...args) => invoke("pickDirectories", ...args),
  pickCatalog: (...args) => invoke("pickCatalog", ...args),
  createCatalog: (...args) => invoke("createCatalog", ...args),

  // ── agent bridge (MCP) ──
  onExternalImport: (...args) => invoke("onExternalImport", ...args),
  onAgentRevealAssets: (...args) => invoke("onAgentRevealAssets", ...args),
  sendAgentRevealResult: (...args) => invoke("sendAgentRevealResult", ...args),
  reportSelection: (...args) => invoke("reportSelection", ...args),
  onCatalogChanged: (...args) => invoke("onCatalogChanged", ...args),

  // ── workspace / catalog ──
  getInfo: (...args) => invoke("getInfo", ...args),
  getSummary: (...args) => invoke("getSummary", ...args),
  getCatalogRoots: (...args) => invoke("getCatalogRoots", ...args),
  registerRoots: (...args) => invoke("registerRoots", ...args),
  switchCatalog: (...args) => invoke("switchCatalog", ...args),
  onMenuAction: (...args) => invoke("onMenuAction", ...args),

  // ── browse & assets ──
  browseImages: (...args) => invoke("browseImages", ...args),
  getFacetValues: (...args) => invoke("getFacetValues", ...args),
  searchFacet: (...args) => invoke("searchFacet", ...args),
  getAssetDetail: (...args) => invoke("getAssetDetail", ...args),
  getAssetDetailById: (...args) => invoke("getAssetDetailById", ...args),
  ensureHdPreviews: (...args) => invoke("ensureHdPreviews", ...args),
  regeneratePreviews: (...args) => invoke("regeneratePreviews", ...args),
  detectEditors: (...args) => invoke("detectEditors", ...args),
  openInEditor: (...args) => invoke("openInEditor", ...args),
  getWatchedDirs: (...args) => invoke("getWatchedDirs", ...args),
  addWatchedDir: (...args) => invoke("addWatchedDir", ...args),
  removeWatchedDir: (...args) => invoke("removeWatchedDir", ...args),
  statDirs: (...args) => invoke("statDirs", ...args),
  onWatchedImport: (cb) => window.mediaWorkspace?.onWatchedImport?.(cb),
  verifyAssets: (...args) => invoke("verifyAssets", ...args),
  relinkAsset: (...args) => invoke("relinkAsset", ...args),
  getInitialLocale: (...args) => invoke("getInitialLocale", ...args),
  setLocale: (...args) => invoke("setLocale", ...args),
  getPending: (...args) => invoke("getPending", ...args),
  quickRegister: (...args) => invoke("quickRegister", ...args),
  getCollageSources: (...args) => invoke("getCollageSources", ...args),
  scanNewMedia: (...args) => invoke("scanNewMedia", ...args),
  getFrameLogos: (...args) => invoke("getFrameLogos", ...args),
  deleteImageAssets: (...args) => invoke("deleteImageAssets", ...args),
  deleteImageAssetsFromDisk: (...args) => invoke("deleteImageAssetsFromDisk", ...args),
  setAssetRating: (...args) => invoke("setAssetRating", ...args),
  saveImage: (...args) => invoke("saveImage", ...args),
  processAndSave: (...args) => invoke("processAndSave", ...args),
  listSystemFonts: (...args) => invoke("listSystemFonts", ...args),

  // ── collections ──
  listCollections: (...args) => invoke("listCollections", ...args),
  createCollection: (...args) => invoke("createCollection", ...args),
  updateCollection: (...args) => invoke("updateCollection", ...args),
  deleteCollection: (...args) => invoke("deleteCollection", ...args),
  collectionAddItems: (...args) => invoke("collectionAddItems", ...args),
  collectionRemoveItems: (...args) => invoke("collectionRemoveItems", ...args),
  browseCollection: (...args) => invoke("browseCollection", ...args),

  // ── jobs ──
  getImportStatus: (...args) => invoke("getImportStatus", ...args),
  startImport: (...args) => invoke("startImport", ...args),
  getEnrichmentStatus: (...args) => invoke("getEnrichmentStatus", ...args),
  startEnrichment: (...args) => invoke("startEnrichment", ...args),
  getPreviewStatus: (...args) => invoke("getPreviewStatus", ...args),
  startPreviewGeneration: (...args) => invoke("startPreviewGeneration", ...args),
  getActiveJobs: (...args) => invoke("getActiveJobs", ...args),
  cancelJob: (...args) => invoke("cancelJob", ...args),
  pauseJob: (...args) => invoke("pauseJob", ...args),
  resumeJob: (...args) => invoke("resumeJob", ...args),

  // ── annotation ──
  getAnnotationSettings: (...args) => invoke("getAnnotationSettings", ...args),
  saveAnnotationSettings: (...args) => invoke("saveAnnotationSettings", ...args),
  getAnnotationKey: (...args) => invoke("getAnnotationKey", ...args),
  setAnnotationKey: (...args) => invoke("setAnnotationKey", ...args),
  deleteAnnotationKey: (...args) => invoke("deleteAnnotationKey", ...args),
  annotateAsset: (...args) => invoke("annotateAsset", ...args),
  startAnnotationJob: (...args) => invoke("startAnnotationJob", ...args),
  getAnnotationJobStatus: (...args) => invoke("getAnnotationJobStatus", ...args),
  countAnnotationTargets: (...args) => invoke("countAnnotationTargets", ...args),
  getAnnotation: (...args) => invoke("getAnnotation", ...args),
  addAssetTag: (...args) => invoke("addAssetTag", ...args),
  removeAssetTag: (...args) => invoke("removeAssetTag", ...args),
  listTags: (...args) => invoke("listTags", ...args),
  testAnnotationConnection: (...args) => invoke("testAnnotationConnection", ...args),
  listAnnotationModels: (...args) => invoke("listAnnotationModels", ...args),

  // ── ai repaint ──
  getAiProviderToken: (...args) => invoke("getAiProviderToken", ...args),
  setAiProviderToken: (...args) => invoke("setAiProviderToken", ...args),
  deleteAiProviderToken: (...args) => invoke("deleteAiProviderToken", ...args),
  getAiPreferences: (...args) => invoke("getAiPreferences", ...args),
  saveAiPreferences: (...args) => invoke("saveAiPreferences", ...args),
  getAiRepaintStatus: (...args) => invoke("getAiRepaintStatus", ...args),
  startAiRepaint: (...args) => invoke("startAiRepaint", ...args),
  listAiModels: (...args) => invoke("listAiModels", ...args),
  listRepaintHistory: (...args) => invoke("listRepaintHistory", ...args),
  getAiStyles: (...args) => invoke("getAiStyles", ...args),
  saveAiStyles: (...args) => invoke("saveAiStyles", ...args),

  // ── stickers / depth / misc ──
  computeDepth: (...args) => invoke("computeDepth", ...args),
  getDepthModel: (...args) => invoke("getDepthModel", ...args),
  pickDepthModel: (...args) => invoke("pickDepthModel", ...args),
  resetDepthModel: (...args) => invoke("resetDepthModel", ...args),
  getPeopleSettings: (...args) => invoke("getPeopleSettings", ...args),
  setPeopleAutomaticDownloads: (...args) => invoke("setPeopleAutomaticDownloads", ...args),
  pickPeopleModel: (...args) => invoke("pickPeopleModel", ...args),
  downloadOfficialPeopleModel: (...args) => invoke("downloadOfficialPeopleModel", ...args),
  setActivePeopleModel: (...args) => invoke("setActivePeopleModel", ...args),
  removePeopleModel: (...args) => invoke("removePeopleModel", ...args),
  startPeopleIndex: (...args) => invoke("startPeopleIndex", ...args),
  getPeopleIndexStatus: (...args) => invoke("getPeopleIndexStatus", ...args),
  listPeopleGroups: (...args) => invoke("listPeopleGroups", ...args),
  peopleGroupDetail: (...args) => invoke("peopleGroupDetail", ...args),
  similarPeopleGroups: (...args) => invoke("similarPeopleGroups", ...args),
  renamePeopleGroup: (...args) => invoke("renamePeopleGroup", ...args),
  setPeopleGroupState: (...args) => invoke("setPeopleGroupState", ...args),
  mergePeopleGroups: (...args) => invoke("mergePeopleGroups", ...args),
  removeFaceFromPerson: (...args) => invoke("removeFaceFromPerson", ...args),
  assignFaceToPerson: (...args) => invoke("assignFaceToPerson", ...args),
  stickerList: (...args) => invoke("stickerList", ...args),
  stickerDetect: (...args) => invoke("stickerDetect", ...args),
  stickerSave: (...args) => invoke("stickerSave", ...args),
  stickerDelete: (...args) => invoke("stickerDelete", ...args),
  stickerToggleStar: (...args) => invoke("stickerToggleStar", ...args),
  stickerCleanupScratch: (...args) => invoke("stickerCleanupScratch", ...args),
};

export default api;
