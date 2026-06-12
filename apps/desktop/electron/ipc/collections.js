// Collections IPC — manual folders, smart filters, manual asset membership,
// plus per-asset rating (lives with collections because ratings often drive
// smart-collection rules). All work goes through the Python sidecar.

function register({ ipcMain, commands, getCatalogState }) {
  ipcMain.handle("workspace:list-collections", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await commands.listCollections();
    } catch (err) {
      console.warn("[workspace:list-collections] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:create-collection", async (_event, name, kind) => {
    return await commands.createCollection(name, kind || "manual");
  });

  ipcMain.handle("workspace:update-collection", async (_event, collectionId, updates) => {
    return await commands.updateCollection(collectionId, updates);
  });

  ipcMain.handle("workspace:delete-collection", async (_event, collectionId) => {
    return await commands.deleteCollection(collectionId);
  });

  ipcMain.handle("workspace:collection-add-items", async (_event, collectionId, assetIds) => {
    return await commands.collectionAddItems(collectionId, assetIds);
  });

  ipcMain.handle("workspace:collection-remove-items", async (_event, collectionId, assetIds) => {
    return await commands.collectionRemoveItems(collectionId, assetIds);
  });

  ipcMain.handle("workspace:set-asset-rating", async (_event, assetIds, rating) => {
    return await commands.setAssetRating(assetIds || [], rating);
  });

  ipcMain.handle("workspace:browse-collection", async (_event, collectionId, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    return await commands.browseCollection(collectionId, options || {});
  });
}

module.exports = { register };
