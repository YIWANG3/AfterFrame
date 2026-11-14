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
const { networkVolumeOf: defaultNetworkVolumeOf } = require("../networkVolume");

// readAppSettings / updateAppSettings: the app settings file, where the
// image pickers keep the folder they were last used in (settings.pickerDirs[key]).
// The result is host.dialogs: every dialog-showing handler, in electron/ipc/
// or a feature module, goes through it.
function createDialogs({
  dialog, BrowserWindow, platform = process.platform,
  readAppSettings = () => ({}), updateAppSettings = async () => {},
}) {
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
  function showMessageBoxFor(event, options) {
    const parent = dialogParent(event);
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

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
  return { dialogParent, showOpenDialogFor, showSaveDialogFor, showMessageBoxFor, pickerStart, rememberPicker };
}

// t(): a translator bound to the current locale. defaultCatalogDir(action):
// where the open / create catalog dialogs start.
function register({
  ipcMain,
  dialogs,
  platform = process.platform,
  t,
  app,
  isPackaged,
  rootDir,
  // Where the open / create catalog dialogs start: the repo's data/ in dev,
  // else Documents (a new catalog goes under Documents/AfterFrame).
  defaultCatalogDir = (action) => {
    if (!isPackaged) return path.join(rootDir, "data");
    return action === "create" ? path.join(app.getPath("documents"), "AfterFrame") : app.getPath("documents");
  },
  catalog: { createAt: createCatalogAt },
  media: { addAllowedMediaDir },
  networkVolumeOf = defaultNetworkVolumeOf,
}) {
  const { showOpenDialogFor, showSaveDialogFor, showMessageBoxFor, pickerStart, rememberPicker } = dialogs;

  // A catalog on a network volume (../networkVolume.js) is slow and can be
  // damaged by a dropped connection. Warn before using one; true = go ahead.
  async function acceptCatalogLocation(event, catalogPath, action) {
    if (!(await networkVolumeOf(catalogPath))) return true;
    const tr = t();
    const { response } = await showMessageBoxFor(event, {
      type: "warning",
      message: tr("dialog.networkCatalogMessage"),
      detail: tr("dialog.networkCatalogDetail"),
      buttons: action === "create"
        ? [tr("dialog.networkCatalogChooseOther"), tr("dialog.networkCatalogCreateAnyway")]
        : [tr("dialog.networkCatalogCancel"), tr("dialog.networkCatalogOpenAnyway")],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
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

  ipcMain.handle("workspace:pick-catalog", async (event) => {
    const options = catalogDialogOptions({ action: "open", defaultDir: defaultCatalogDir("open"), t: t() });
    const result = await showOpenDialogFor(event, options);
    if (result.canceled || !result.filePaths[0]) return null;
    return (await acceptCatalogLocation(event, result.filePaths[0], "open")) ? result.filePaths[0] : null;
  });

  // "Choose Another Location" on the network warning shows the dialog again.
  ipcMain.handle("workspace:create-catalog", async (event) => {
    const options = catalogDialogOptions({ action: "create", defaultDir: defaultCatalogDir("create"), t: t() });
    for (;;) {
      const result = await showSaveDialogFor(event, options);
      if (result.canceled || !result.filePath) return null;
      if (await acceptCatalogLocation(event, result.filePath, "create")) return createCatalogAt(result.filePath);
    }
  });
}

module.exports = { createDialogs, register };
