// Read-only catalog queries — gallery browse + asset detail lookups.
// All wrap the Python sidecar; return empty results when no catalog loaded.

function register({ ipcMain, commands, getCatalogState }) {
  ipcMain.handle("workspace:browse", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    return await commands.browseExports(options);
  });

  ipcMain.handle("workspace:facet-values", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return null;
    try {
      return await commands.facetValues();
    } catch (err) {
      console.warn("[workspace:facet-values] sidecar error:", err.message);
      return null;
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

  ipcMain.handle("workspace:detail", async (_event, exportPath) => {
    return await commands.assetDetail({ exportPath });
  });

  ipcMain.handle("workspace:detail-by-id", async (_event, assetId) => {
    return await commands.assetDetail({ assetId });
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
