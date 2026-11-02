// AI Repaint, main-process side (features/repaint/manifest.mjs `electron`):
// the repaint job's start and status, a photo's repaint history, the style
// library (a JSON file under userData/afterframe/) and the picker for style
// reference images. The providers' credentials, preferences and model listing
// are the host's (electron/ipc/ai.js): the editor's text tool shares them.

const path = require("node:path");
const fs = require("node:fs");
const { writeJsonAtomic } = require("../../../electron/settingsStore");
const { jobStatusHandler } = require("../../../electron/ipc/guard");

function register({
  app,
  ipcMain,
  commands,
  dialogs,
  catalog: { state: getCatalogState },
  media: { addAllowedMediaDir },
  tasks: { startAiRepaintTask, latestJobStatus, formatJobStatus },
}) {
  function aiStylesPath() {
    return path.join(app.getPath("userData"), "afterframe", "ai-styles.json");
  }
  function readAiStyles() {
    try {
      return JSON.parse(fs.readFileSync(aiStylesPath(), "utf-8"));
    } catch {
      return null;
    }
  }

  ipcMain.handle("workspace:ai-repaint-status", jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, "ai_repaint"));

  ipcMain.handle("workspace:ai-repaint-start", (_event, options) => startAiRepaintTask(options));

  ipcMain.handle("workspace:list-repaint-history", async (_event, assetPath) => {
    if (!assetPath) return [];
    return await commands.listRepaintHistory(assetPath);
  });

  ipcMain.handle("workspace:get-ai-styles", () => readAiStyles());

  ipcMain.handle("workspace:save-ai-styles", async (_event, styles) => {
    await writeJsonAtomic(aiStylesPath(), styles);
  });

  // Style references: photos whose colours and mood the repaint should take
  // on. Several at once; each goes to the job as --reference, and their
  // folders are allowed through media:// for the panel's thumbnails.
  ipcMain.handle("workspace:pick-repaint-refs", async (event) => {
    const result = await dialogs.showOpenDialogFor(event, {
      title: "Choose reference images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic", "tif", "tiff"] }],
      ...dialogs.pickerStart("repaintReference"),
    });
    if (result.canceled || !result.filePaths.length) return [];
    for (const dir of new Set(result.filePaths.map((p) => path.dirname(p)))) addAllowedMediaDir(dir);
    dialogs.rememberPicker("repaintReference", result.filePaths[0]);
    return result.filePaths;
  });
}

module.exports = { register };
