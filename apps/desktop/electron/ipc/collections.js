// Collections IPC — manual folders, smart filters, manual asset membership,
// plus per-asset rating (lives with collections because ratings often drive
// smart-collection rules). All work goes through the Python sidecar.

function register({ ipcMain, callSidecarJsonAsync, getCatalogState }) {
  ipcMain.handle("workspace:list-collections", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await callSidecarJsonAsync(["list-collections"]) || [];
    } catch (err) {
      console.warn("[workspace:list-collections] sidecar error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:create-collection", async (_event, name, kind) => {
    return await callSidecarJsonAsync(["create-collection", "--name", name, "--kind", kind || "manual"]);
  });

  ipcMain.handle("workspace:update-collection", async (_event, collectionId, updates) => {
    const command = ["update-collection", "--collection-id", collectionId];
    if (updates.name != null) command.push("--name", updates.name);
    if (updates.rulesJson != null) command.push("--rules-json", updates.rulesJson);
    if (updates.sortOrder != null) command.push("--sort-order", String(updates.sortOrder));
    return await callSidecarJsonAsync(command);
  });

  ipcMain.handle("workspace:delete-collection", async (_event, collectionId) => {
    return await callSidecarJsonAsync(["delete-collection", "--collection-id", collectionId]);
  });

  ipcMain.handle("workspace:collection-add-items", async (_event, collectionId, assetIds) => {
    const command = ["collection-add-items", "--collection-id", collectionId];
    for (const id of assetIds) command.push("--asset-id", id);
    return await callSidecarJsonAsync(command);
  });

  ipcMain.handle("workspace:collection-remove-items", async (_event, collectionId, assetIds) => {
    const command = ["collection-remove-items", "--collection-id", collectionId];
    for (const id of assetIds) command.push("--asset-id", id);
    return await callSidecarJsonAsync(command);
  });

  ipcMain.handle("workspace:set-asset-rating", async (_event, assetIds, rating) => {
    const command = ["set-asset-rating", "--rating", String(rating)];
    for (const id of assetIds || []) command.push("--asset-id", id);
    return await callSidecarJsonAsync(command);
  });

  ipcMain.handle("workspace:browse-collection", async (_event, collectionId, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    return await callSidecarJsonAsync([
      "browse-collection",
      "--collection-id",
      collectionId,
      "--limit",
      String(options?.limit || 120),
      "--offset",
      String(options?.offset || 0),
    ]) || [];
  });
}

module.exports = { register };
