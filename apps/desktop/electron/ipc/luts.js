// LUT library IPC (docs/lut-plan.md §1): the editor's LUT tool and the
// Library settings read it; ../lutLibrary.js does the work. Errors come back
// as { error: code } rather than thrown: an IPC rejection loses its code.

const path = require("node:path");
const fs = require("node:fs");
const { createLutLibrary } = require("../lutLibrary");

function register({ app, ipcMain, dialog, shell, readAppSettings, updateAppSettings, getMainWindow }) {
  const base = path.join(app.getPath("userData"), "afterframe");
  const library = createLutLibrary({
    libraryDir: path.join(base, "luts"),
    indexPath: path.join(base, "luts-index.json"),
    readFolders: () => readAppSettings()?.lutFolders || [],
    writeFolders: (lutFolders) => updateAppSettings((s) => ({ ...s, lutFolders })),
  });

  const parent = () => getMainWindow?.() || undefined;

  ipcMain.handle("app:luts", () => library.list());

  ipcMain.handle("app:read-lut", (_event, id) => library.read(String(id || "")));

  // `options`: paths to import (drag and drop, the e2e specs), or nothing for
  // the open dialog (files and folders both).
  ipcMain.handle("app:import-luts", async (_event, options) => {
    let paths = Array.isArray(options) ? options.map(String) : null;
    if (!paths) {
      const result = await dialog.showOpenDialog(parent(), {
        properties: ["openFile", "openDirectory", "multiSelections"],
        filters: [{ name: "LUT (.cube)", extensions: ["cube"] }],
      });
      if (result.canceled) return { canceled: true };
      paths = result.filePaths;
    }
    return library.importPaths(paths);
  });

  ipcMain.handle("app:add-lut-folder", async (_event, folder) => {
    let target = typeof folder === "string" ? folder : null;
    if (!target) {
      const result = await dialog.showOpenDialog(parent(), { properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths?.length) return { canceled: true };
      target = result.filePaths[0];
    }
    return library.addFolder(target);
  });

  ipcMain.handle("app:remove-lut-folder", (_event, folder) => library.removeFolder(String(folder || "")));

  ipcMain.handle("app:set-lut-log-mark", (_event, id, mark) => library.setLogMark(String(id || ""), mark));

  ipcMain.handle("app:reveal-lut", async (_event, id) => {
    const where = await library.locate(String(id || ""));
    if (!where) return false;
    shell.showItemInFolder(where.path);
    return true;
  });

  // To the Trash, never deleted: a LUT someone bought is not ours to destroy.
  ipcMain.handle("app:trash-lut", async (_event, id) => {
    const file = await library.libraryPath(String(id || ""));
    if (!file) return { error: "not_in_library" };
    try {
      await shell.trashItem(file);
      library.forget(id);
      return { ok: true };
    } catch (error) {
      return { error: "failed", message: String(error?.message || error) };
    }
  });

  // The whole library folder goes to the Trash as one item ("luts"), so it
  // can be put back in one move; an empty one takes its place.
  ipcMain.handle("app:clear-lut-library", async () => {
    try {
      if (fs.existsSync(library.libraryDir)) await shell.trashItem(library.libraryDir);
      await fs.promises.mkdir(library.libraryDir, { recursive: true });
      return { ok: true };
    } catch (error) {
      return { error: "failed", message: String(error?.message || error) };
    }
  });

  return { library };
}

module.exports = { register };
