// Asset-level IPC: quick-register (after a save), collage-sources lookup,
// delete-export-assets, and the cross-platform "reveal in Finder/Explorer".

function register({ ipcMain, shell, callSidecarJsonAsync }) {
  ipcMain.handle("workspace:reveal", (_event, targetPath) => {
    if (!targetPath) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });

  ipcMain.handle("workspace:quick-register", async (_event, exportPath, originPath, collageSourceIds) => {
    if (!exportPath) return null;
    const command = ["quick-register", "--export-path", exportPath];
    if (originPath) command.push("--origin-path", originPath);
    if (Array.isArray(collageSourceIds) && collageSourceIds.length) {
      command.push("--collage-source-ids", ...collageSourceIds);
    }
    return await callSidecarJsonAsync(command);
  });

  ipcMain.handle("workspace:collage-sources", async (_event, assetId) => {
    if (!assetId) return { sources: [], used_in_collages: [] };
    return await callSidecarJsonAsync(["collage-sources", "--asset-id", assetId]);
  });

  ipcMain.handle("workspace:delete-export-assets", async (_event, assetIds) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const command = ["delete-export-assets"];
    for (const assetId of ids) command.push("--asset-id", String(assetId));
    return await callSidecarJsonAsync(command) || [];
  });
}

module.exports = { register };
