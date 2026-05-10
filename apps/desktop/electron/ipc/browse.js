// Read-only catalog queries — gallery browse + asset detail lookups.
// All wrap the Python sidecar; return empty results when no catalog loaded.

function register({ ipcMain, callSidecarJsonAsync, getCatalogState }) {
  ipcMain.handle("workspace:browse", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    const command = [
      "browse-exports",
      "--status", options.status,
      "--limit", String(options.limit),
      "--offset", String(options.offset),
    ];
    if (options.search) command.push("--search", options.search);
    if (options.sort) command.push("--sort", options.sort);
    return await callSidecarJsonAsync(command) || [];
  });

  ipcMain.handle("workspace:detail", async (_event, exportPath) => {
    return await callSidecarJsonAsync(["asset-detail", "--export-path", exportPath]);
  });

  ipcMain.handle("workspace:detail-by-id", async (_event, assetId) => {
    return await callSidecarJsonAsync(["asset-detail", "--asset-id", assetId]);
  });

  ipcMain.handle("workspace:pending", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      return await callSidecarJsonAsync(["list-pending"]) || [];
    } catch (err) {
      console.warn("[workspace:pending] sidecar error:", err.message);
      return [];
    }
  });
}

module.exports = { register };
