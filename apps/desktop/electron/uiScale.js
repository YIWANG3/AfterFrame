// Interface scale: the whole window zoomed as one (Chromium's page zoom), so
// every panel, list and font follows without a second set of sizes in the
// components. The main process owns it like the locale (persisted in
// settings.json as `uiScale`), applies it to each window once its page has
// loaded, and answers the renderer's Settings row.

const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25];
const DEFAULT_UI_SCALE = 1;

const normalize = (value) => (UI_SCALES.includes(Number(value)) ? Number(value) : DEFAULT_UI_SCALE);

function createUiScale({ ipcMain, readAppSettings, updateAppSettings, getWindows }) {
  let current = normalize(readAppSettings().uiScale);

  function applyTo(window) {
    if (!window || window.isDestroyed?.()) return;
    window.webContents?.setZoomFactor?.(current);
  }

  async function setUiScale(value) {
    if (!UI_SCALES.includes(Number(value))) return current;
    current = Number(value);
    await updateAppSettings((s) => ({ ...s, uiScale: current }));
    for (const window of getWindows?.() || []) applyTo(window);
    return current;
  }

  ipcMain.handle("app:get-ui-scale", () => current);
  ipcMain.handle("app:set-ui-scale", (_event, value) => setUiScale(value));

  return { current: () => current, applyTo, setUiScale };
}

module.exports = { createUiScale, UI_SCALES, DEFAULT_UI_SCALE };
