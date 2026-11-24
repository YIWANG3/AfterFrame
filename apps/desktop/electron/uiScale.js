// Interface scale: the whole window zoomed as one (Chromium's page zoom), so
// every panel, list and font follows without a second set of sizes in the
// components. The main process owns it like the locale (persisted in
// settings.json as `uiScale`), applies it to each window once its page has
// loaded, and answers the renderer's Settings row. The View menu's Zoom In /
// Zoom Out / Actual Size (rebindable, shared/shortcuts.mjs) step it.

const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25];
const DEFAULT_UI_SCALE = 1;

const NUMPAD_STEPS = { NumpadAdd: 1, NumpadSubtract: -1, Numpad0: 0 };

const normalize = (value) => (UI_SCALES.includes(Number(value)) ? Number(value) : DEFAULT_UI_SCALE);

function createUiScale({ ipcMain, readAppSettings, updateAppSettings, getWindows }) {
  let current = normalize(readAppSettings().uiScale);

  function applyTo(window) {
    if (!window || window.isDestroyed?.()) return;
    window.webContents?.setZoomFactor?.(current);
    // The page sizes the traffic-light gutters in screen points from this
    // (--ui-zoom, index.css): the zoom scales CSS pixels, not the lights.
    window.webContents?.send?.("app:ui-scale", current);
  }

  async function setUiScale(value) {
    if (!UI_SCALES.includes(Number(value))) return current;
    current = Number(value);
    await updateAppSettings((s) => ({ ...s, uiScale: current }));
    for (const window of getWindows?.() || []) applyTo(window);
    return current;
  }

  // ⌘= / ⌘- / ⌘0 (Ctrl elsewhere), like VS Code: one notch along UI_SCALES
  // (staying put at either end), or back to 100% for 0.
  function step(direction) {
    if (!direction) return setUiScale(DEFAULT_UI_SCALE);
    const index = UI_SCALES.indexOf(current);
    const next = UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, index + Math.sign(direction)))];
    return next === current ? Promise.resolve(current) : setUiScale(next);
  }

  // The number pad's + / - / 0 with ⌘ (Ctrl): a menu item carries one
  // accelerator, so the menu has the main row and these are caught here.
  function handleNumpad(event, input, platform = process.platform) {
    if (input.type !== "keyDown") return;
    const mod = platform === "darwin" ? input.meta : input.control;
    if (!mod || input.alt || input.shift) return;
    const direction = NUMPAD_STEPS[input.code];
    if (direction === undefined) return;
    event.preventDefault();
    void step(direction);
  }

  ipcMain.handle("app:get-ui-scale", () => current);
  ipcMain.handle("app:set-ui-scale", (_event, value) => setUiScale(value));

  return { current: () => current, applyTo, setUiScale, step, handleNumpad };
}

module.exports = { createUiScale, UI_SCALES, DEFAULT_UI_SCALE };
