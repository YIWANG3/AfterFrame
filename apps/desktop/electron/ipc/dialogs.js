// Native file dialogs: the open / save helpers every dialog-showing handler
// goes through, and the four pickers that belong to no other ipc module
// (import sources, a handwriting reference image, open / create catalog).
//
// Windows and Linux make a dialog modal to the window that asked for it, so
// it can't slip behind the window and leave it clickable; macOS keeps its
// free-standing panels.

const fs = require("node:fs");
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
// where the open / create catalog dialogs start. readAppSettings /
// updateAppSettings: the app settings file, where the image pickers keep the
// folder they were last used in (settings.pickerDirs[key]).
function register({
  ipcMain,
  dialogs,
  platform = process.platform,
  t,
  defaultCatalogDir,
  createCatalogAt,
  addAllowedMediaDir,
  readAppSettings = () => ({}),
  updateAppSettings = async () => {},
}) {
  const { showOpenDialogFor, showSaveDialogFor } = dialogs;

  // The reference-image pickers open where they were last used: macOS only
  // remembers a panel's folder on its own when nothing else is asked of it,
  // and a reference is usually one of several in the same folder.
  function pickerStart(key) {
    const dir = readAppSettings()?.pickerDirs?.[key];
    return typeof dir === "string" && dir && fs.existsSync(dir) ? { defaultPath: dir } : {};
  }
  function rememberPicker(key, filePath) {
    const dir = path.dirname(filePath);
    void updateAppSettings((settings) => ({
      ...settings,
      pickerDirs: { ...(settings?.pickerDirs || {}), [key]: dir },
    }));
  }

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
      ...pickerStart("handwritingReference"),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    addAllowedMediaDir(path.dirname(filePath));
    rememberPicker("handwritingReference", filePath);
    return filePath;
  });

  // AI repaint style references: photos whose colours and mood the repaint
  // should take on. Several at once; each goes to the job as --reference, and
  // their folders are allowed through media:// for the panel's thumbnails.
  ipcMain.handle("workspace:pick-repaint-refs", async (event) => {
    const result = await showOpenDialogFor(event, {
      title: "Choose reference images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic", "tif", "tiff"] }],
      ...pickerStart("repaintReference"),
    });
    if (result.canceled || !result.filePaths.length) return [];
    for (const dir of new Set(result.filePaths.map((p) => path.dirname(p)))) addAllowedMediaDir(dir);
    rememberPicker("repaintReference", result.filePaths[0]);
    return result.filePaths;
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
