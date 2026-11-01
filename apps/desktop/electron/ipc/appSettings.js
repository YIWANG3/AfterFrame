// App-wide (catalog-independent) settings the Settings window reads and
// writes: the cache folders it can open, preview generation, the user's
// keyboard shortcuts and whether the menu shows them as accelerators.

const path = require("node:path");
const fs = require("node:fs");
const { sanitizeOverrides: sanitizeShortcutOverrides } = require("../../shared/shortcuts.mjs");

// The caches a user may want to clear by hand, under userData.
function cacheDirs(userData) {
  return {
    depth: path.join(userData, "depth-cache"),
    stickers: path.join(userData, "stickers"),
    videoProxies: path.join(userData, "video-proxies"),
    // JPEG renders of originals the renderer can't decode (electron/media/protocol.js).
    renders: path.join(userData, "transcode-cache"),
    luts: path.join(userData, "afterframe", "luts"),
  };
}

function register({
  ipcMain,
  shell,
  getUserDataPath,
  readAppSettings,
  updateAppSettings,
  platform = process.platform,
  installMenu,
  setMenuAccelerators,
}) {
  // Open an app cache directory in Finder / Explorer (for manual cleanup).
  ipcMain.handle("app:open-cache-dir", (_event, kind) => {
    const dir = cacheDirs(getUserDataPath())[kind];
    if (!dir) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      void shell.openPath(dir);
      return true;
    } catch {
      return false;
    }
  });

  // Preview settings (e.g. HD generation toggle). Stored under settings.previews.
  ipcMain.handle("app:get-preview-settings", () => readAppSettings()?.previews ?? {});
  ipcMain.handle("app:save-preview-settings", async (_event, next) => {
    const persisted = await updateAppSettings((s) => ({
      ...s,
      previews: { ...(s?.previews || {}), ...(next || {}) },
    }));
    return persisted.previews ?? {};
  });

  // Keyboard shortcuts the user rebound (Settings → Keyboard Shortcuts), stored
  // as overrides of shared/shortcuts.mjs's defaults under settings.shortcuts.
  // Saving reinstalls the menu so its accelerators follow.
  ipcMain.handle("app:get-shortcuts", () => sanitizeShortcutOverrides(readAppSettings()?.shortcuts, platform));
  ipcMain.handle("app:save-shortcuts", async (_event, next) => {
    const clean = sanitizeShortcutOverrides(next, platform);
    const persisted = await updateAppSettings((s) => ({ ...s, shortcuts: clean }));
    installMenu();
    return persisted.shortcuts ?? {};
  });
  ipcMain.handle("app:set-menu-accelerators", (_event, on) => {
    setMenuAccelerators(on !== false);
    return true;
  });
}

module.exports = { register, cacheDirs };
