// Read-only catalog queries — gallery browse + asset detail lookups.
// All wrap the Python sidecar; return empty results when no catalog loaded.

// Files per thumbnail pass: keeps a pass's command line short, and a long
// queue of missing thumbnails made in steps.
const ENSURE_CHUNK = 200;

function register({ ipcMain, commands, getCatalogState }) {
  ipcMain.handle("workspace:locate-image-asset", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return { index: null };
    return commands.locateImageAsset(options);
  });
  ipcMain.handle("workspace:browse", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    return await commands.browseImages(options);
  });

  ipcMain.handle("workspace:browse-map-points", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.browseMapPoints(options || {});
    } catch (err) {
      console.warn("[workspace:browse-map-points] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:discover-collections", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return { places: [], memories: [] };
    try {
      return await commands.discoverCollections();
    } catch (err) {
      console.warn("[workspace:discover-collections] sidecar error:", err.message);
      return { places: [], memories: [] };
    }
  });

  ipcMain.handle("workspace:get-asset-location", async (_event, assetId) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb() || !assetId) return null;
    try {
      return await commands.getAssetLocation(assetId);
    } catch (err) {
      console.warn("[workspace:get-asset-location] sidecar error:", err.message);
      return null;
    }
  });

  ipcMain.handle("workspace:resolve-ai-locations", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return null;
    try {
      return await commands.resolveAiLocations();
    } catch (err) {
      console.warn("[workspace:resolve-ai-locations] sidecar error:", err.message);
      return null;
    }
  });

  ipcMain.handle("workspace:facet-values", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return null;
    try {
      return await commands.facetValues(options || {});
    } catch (err) {
      console.warn("[workspace:facet-values] sidecar error:", err.message);
      return null;
    }
  });

  ipcMain.handle("workspace:camera-makes", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.cameraMakes();
    } catch (err) {
      console.warn("[workspace:camera-makes] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:search-facet", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    const opts = options || {};
    if (!opts.field) return [];
    try {
      return await commands.searchFacet(opts);
    } catch (err) {
      console.warn("[workspace:search-facet] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:detail", async (_event, imagePath) => {
    return await commands.assetDetail({ imagePath });
  });

  ipcMain.handle("workspace:detail-by-id", async (_event, assetId) => {
    return await commands.assetDetail({ assetId });
  });

  ipcMain.handle("workspace:list-people-groups", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.listPeopleGroups(options || {});
    } catch (err) {
      console.warn("[workspace:list-people-groups] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:similar-people-groups", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.similarPeopleGroups(options || {});
    } catch (err) {
      console.warn("[workspace:similar-people-groups] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:people-group-detail", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return null;
    try {
      return await commands.peopleGroupDetail(options || {});
    } catch (err) {
      console.warn("[workspace:people-group-detail] sidecar error:", err.message);
      return null;
    }
  });

  // People corrections write membership audit rows in the sidecar; errors are
  // surfaced to the renderer so the user sees why a rename/merge didn't land.
  ipcMain.handle("workspace:rename-people-group", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.renamePeopleGroup(options || {});
  });

  ipcMain.handle("workspace:set-people-group-cover", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.setPeopleGroupCover(options || {});
  });

  ipcMain.handle("workspace:set-people-group-state", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.setPeopleGroupState(options || {});
  });

  ipcMain.handle("workspace:set-people-groups-state", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.setPeopleGroupsState(options || {});
  });

  ipcMain.handle("workspace:merge-people-groups", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.mergePeopleGroups(options || {});
  });

  ipcMain.handle("workspace:remove-face-from-person", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.removeFaceFromPerson(options || {});
  });

  ipcMain.handle("workspace:assign-face-to-person", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    return await commands.assignFaceToPerson(options || {});
  });

  // On-demand HD previews for specific source paths (collage cells). Skips files
  // that already have an HD preview, so it's cheap to call on every open.
  ipcMain.handle("workspace:ensure-hd-previews", async (_event, paths) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return { generated: 0, skipped: 0 };
    const list = [...new Set((paths || []).map(String).filter(Boolean))];
    if (!list.length) return { generated: 0, skipped: 0 };
    try {
      return await commands.ensureHdPreviews(list);
    } catch (err) {
      console.warn("[workspace:ensure-hd-previews] sidecar error:", err.message);
      return { error: String(err.message) };
    }
  });

  // Force-regenerate the thumbnail previews for specific source files — the
  // gallery calls this when a preview <img> fails to load (missing/corrupt
  // preview file), so broken thumbnails self-heal on view without a re-import.
  ipcMain.handle("workspace:regenerate-previews", async (_event, paths) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return { generated: 0, skipped: 0 };
    const list = [...new Set((paths || []).map(String).filter(Boolean))];
    if (!list.length) return { generated: 0, skipped: 0 };
    try {
      return await commands.regeneratePreviews(list);
    } catch (err) {
      console.warn("[workspace:regenerate-previews] sidecar error:", err.message);
      return { error: String(err.message) };
    }
  });

  // Thumbnails missing from the gallery: an import cancelled before its
  // thumbnail pass, a file whose thumbnail failed. Made where missing, in a
  // background process, one pass at a time (two would only read the same disk
  // against each other) and at most ENSURE_CHUNK files a process.
  let ensuring = Promise.resolve();
  ipcMain.handle("workspace:ensure-previews", async (_event, paths) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    const total = { generated: 0, skipped: 0, failed: 0, deferred: 0 };
    if (!currentCatalogPath || !catalogHasDb()) return total;
    const list = [...new Set((paths || []).map(String).filter(Boolean))];
    for (let start = 0; start < list.length; start += ENSURE_CHUNK) {
      const chunk = list.slice(start, start + ENSURE_CHUNK);
      const pass = ensuring.then(() => commands.ensurePreviews(chunk));
      ensuring = pass.catch(() => {});
      try {
        const result = await pass;
        for (const key of Object.keys(total)) total[key] += Number(result?.[key] || 0);
      } catch (err) {
        console.warn("[workspace:ensure-previews] sidecar error:", err.message);
        return { ...total, error: String(err.message) };
      }
    }
    return total;
  });

  ipcMain.handle("workspace:refresh-assets", async (_event, paths) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog first.");
    const list = [...new Set((paths || []).map(String).filter(Boolean))];
    if (!list.length) return { requested: 0, refreshed: 0, deferred: 0, failed: 0 };
    try {
      return await commands.refreshAssets(list);
    } catch (err) {
      console.warn("[workspace:refresh-assets] sidecar error:", err.message);
      throw err;
    }
  });

  ipcMain.handle("workspace:pending", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.listPending();
    } catch (err) {
      console.warn("[workspace:pending] sidecar error:", err.message);
      return [];
    }
  });
}

module.exports = { register };
