// Native file dialogs: the open / save helpers every dialog-showing handler
// goes through, and the four pickers that belong to no other ipc module
// (import sources, a handwriting reference image, open / create catalog).
//
// Windows and Linux make a dialog modal to the window that asked for it, so
// it can't slip behind the window and leave it clickable; macOS keeps its
// free-standing panels.

const path = require("node:path");
const { importDialogOptions } = require("../importDialog");
const { catalogDialogOptions } = require("../catalogDialog");

function createDialogs({ dialog, BrowserWindow, platform = process.platform }) {
  // dialogParent(event): the window a dialog is modal to, or null (macOS).
  const dialogParent = (event) => (platform === "darwin" ? null : BrowserWindow.fromWebContents(event.sender));
  function showOpenDialogFor(event, options) {
    const parent = dialogParent(event);
    return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
  }
  function showSaveDialogFor(event, options) {
    const parent = dialogParent(event);
    return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
  }
  return { dialogParent, showOpenDialogFor, showSaveDialogFor };
}

// t(): a translator bound to the current locale. defaultCatalogDir(action):
// where the open / create catalog dialogs start.
function register({
  ipcMain,
  dialogs,
  platform = process.platform,
  t,
  defaultCatalogDir,
  createCatalogAt,
  addAllowedMediaDir,
}) {
  const { showOpenDialogFor, showSaveDialogFor } = dialogs;

  // pick: "files" | "folders" from Import Files… / Import Folder… on Windows and
  // Linux, whose dialogs can't take both (../importDialog.js).
  ipcMain.handle("workspace:pick-directories", async (event, kind, pick) => {
    const options = importDialogOptions({ platform, kind, pick, t: t() });
    const result = await showOpenDialogFor(event, options);
    return result.canceled ? [] : result.filePaths;
  });

  // Handwriting reference image (style-transfer source). The chosen file is fed
  // to the text-image job as --ref-image; allow it through media:// so the modal
  // can show a thumbnail.
  ipcMain.handle("workspace:pick-handwriting-ref", async (event) => {
    const result = await showOpenDialogFor(event, {
      title: "Choose reference image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    addAllowedMediaDir(path.dirname(filePath));
    return filePath;
  });

  ipcMain.handle("workspace:pick-catalog", async (event) => {
    const options = catalogDialogOptions({ action: "open", defaultDir: defaultCatalogDir("open"), t: t() });
    const result = await showOpenDialogFor(event, options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("workspace:create-catalog", async (event) => {
    const options = catalogDialogOptions({ action: "create", defaultDir: defaultCatalogDir("create"), t: t() });
    const result = await showSaveDialogFor(event, options);
    if (result.canceled || !result.filePath) return null;
    return createCatalogAt(result.filePath);
  });
}

module.exports = { createDialogs, register };
