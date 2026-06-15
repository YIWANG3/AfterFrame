// Asset-level IPC: quick-register (after a save), collage-sources lookup,
// delete-image-assets, and the cross-platform "reveal in Finder/Explorer".

function register({ ipcMain, shell, dialog, BrowserWindow, commands, callSidecarJsonAsync, addAllowedMediaDir, getCatalogState, t }) {
  const fs = require("node:fs");
  const path = require("node:path");
  // t() returns a translator bound to the current locale; fall back to identity
  // (English literals) if i18n wasn't wired (e.g. older callers/tests).
  const tr = () => (typeof t === "function" ? t() : (key) => key);

  ipcMain.handle("workspace:reveal", (_event, targetPath) => {
    if (!targetPath) return false;
    // Don't silently no-op on a moved/deleted original — report it so the
    // renderer can toast instead of opening Finder with nothing selected.
    if (!fs.existsSync(targetPath)) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });

  // Full-library missing-file sweep (File ▸ Verify Files menu action).
  ipcMain.handle("workspace:verify-assets", async (_event, options) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState?.() || {};
    if (!currentCatalogPath || !catalogHasDb?.()) return null;
    return await commands.verifyAssets(options || {});
  });

  // Relink a missing asset to a new on-disk location. With no newPath we open a
  // native file picker. Returns the sidecar result verbatim, including the
  // {status:"fingerprint_mismatch"} case so the renderer can confirm + retry.
  ipcMain.handle("workspace:relink-asset", async (_event, options) => {
    const opts = options || {};
    if (!opts.assetId) return null;
    let newPath = opts.newPath;
    if (!newPath) {
      const parent = BrowserWindow.getFocusedWindow();
      const translate = tr();
      const result = await dialog.showOpenDialog(parent, {
        title: translate("dialog.relinkTitle"),
        properties: ["openFile"],
        message: translate("dialog.relinkMessage"),
      });
      if (result.canceled || !result.filePaths?.length) return { status: "cancelled" };
      newPath = result.filePaths[0];
    }
    const outcome = await commands.relinkAsset({ assetId: opts.assetId, newPath, force: !!opts.force });
    // Let media:// load the relinked original right away.
    if (outcome?.status === "relinked" && outcome.new_path) {
      addAllowedMediaDir?.(path.dirname(outcome.new_path));
    }
    return outcome;
  });

  ipcMain.handle("workspace:open-external", (_event, url) => {
    if (!url || typeof url !== "string") return false;
    // Only allow http(s) so a misuse can't, e.g., launch file:// or javascript:.
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });

  ipcMain.handle("workspace:quick-register", async (_event, imagePath, originPath, collageSourceIds) => {
    if (!imagePath) return null;
    // The renderer will media:// this file right after registering it.
    addAllowedMediaDir?.(require("node:path").dirname(imagePath));
    return await commands.quickRegister({ imagePath, originPath, collageSourceIds });
  });

  ipcMain.handle("workspace:collage-sources", async (_event, assetId) => {
    if (!assetId) return { sources: [], used_in_collages: [] };
    return await callSidecarJsonAsync(["collage-sources", "--asset-id", assetId]);
  });

  ipcMain.handle("workspace:delete-image-assets", async (_event, assetIds) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const command = ["delete-image-assets"];
    for (const assetId of ids) command.push("--asset-id", String(assetId));
    return await callSidecarJsonAsync(command) || [];
  });
}

module.exports = { register };
