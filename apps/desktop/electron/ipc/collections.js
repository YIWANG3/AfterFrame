// Collections IPC — manual folders (which nest: a folder can sit inside
// another), smart filters, manual asset membership, plus per-asset rating
// (lives with collections because ratings often drive smart-collection
// rules). All work goes through the Python sidecar.

const { withCatalog } = require("./guard");

function register({ ipcMain, commands, catalog: { state: getCatalogState } }) {
  const guarded = (fallback, fn) => withCatalog(getCatalogState, fallback, fn);

  ipcMain.handle("workspace:list-collections", guarded([], async () => {
    try {
      return await commands.listCollections();
    } catch (err) {
      console.warn("[workspace:list-collections] sidecar error:", err.message);
      return [];
    }
  }));

  // One level at a time: the folders directly under parentId (null = top).
  ipcMain.handle("workspace:reorder-collections", async (_event, collectionIds, parentId) => {
    return await commands.reorderCollections(collectionIds, parentId || null);
  });

  ipcMain.handle("workspace:create-collection", async (_event, name, kind, rules, parentId) => {
    return await commands.createCollection(name, kind || "manual", rules || null, parentId || null);
  });

  // Into another folder, or to the top level with no parent.
  ipcMain.handle("workspace:move-collection", async (_event, collectionId, parentId) => {
    return await commands.moveCollection(collectionId, parentId || null);
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

  ipcMain.handle("workspace:set-asset-description", async (_event, assetIds, text) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    if (!ids.length) return null;
    return await commands.setAssetDescription(ids, typeof text === "string" ? text : null);
  });

  // flag: "pick" | "reject" | "none".
  ipcMain.handle("workspace:set-asset-flag", async (_event, assetIds, flag) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    if (!ids.length) return null;
    return await commands.setAssetFlag(ids, flag);
  });

  ipcMain.handle("workspace:browse-collection", guarded([], (_event, collectionId, options) =>
    commands.browseCollection(collectionId, options || {})));
}

module.exports = { register };
