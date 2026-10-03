// The open dialog behind Import and Add Raw Sources. macOS picks files and
// folders in one dialog. Windows and Linux can't: asked for both, they show a
// folder picker, so a single photo couldn't be imported from the dialog at
// all. There Import is two commands, Import Files… and Import Folder…, which
// pass `pick`. Without one, those platforms get folders, as before.
//   kind   "image" (Import) or "raw" (Add Raw Sources)
//   pick   "files" | "folders" | undefined (macOS: both)
//   t      main-process translator (./i18n)

function importDialogOptions({ platform, kind, pick, t }) {
  const raw = kind === "raw";
  if (platform === "darwin" && !pick) {
    return {
      title: t(raw ? "dialog.addRawTitle" : "dialog.importTitle"),
      properties: ["openFile", "openDirectory", "multiSelections"],
    };
  }
  if (pick === "files") {
    return {
      title: t(raw ? "dialog.addRawFilesTitle" : "dialog.importFilesTitle"),
      properties: ["openFile", "multiSelections"],
    };
  }
  return {
    title: t(raw ? "dialog.addRawFoldersTitle" : "dialog.importFoldersTitle"),
    properties: ["openDirectory", "multiSelections"],
  };
}

// Whether this platform needs Import split into files and folders.
const splitsImport = (platform) => platform !== "darwin";

module.exports = { importDialogOptions, splitsImport };
