// The UI language. The main process owns it (persisted in settings.json) so
// the menu and the renderer never disagree: the renderer reads it
// synchronously at startup through the preload bridge (app:get-locale), and
// setting it persists, then rebuilds the menu so it flips language together
// with the UI.

const SUPPORTED_LOCALES = ["en", "zh-CN"];

function createLocale({ ipcMain, readAppSettings, updateAppSettings, onChange }) {
  const stored = readAppSettings().locale;
  let current = SUPPORTED_LOCALES.includes(stored) ? stored : "en";

  async function applyLocale(lng) {
    if (!SUPPORTED_LOCALES.includes(lng)) return current;
    await updateAppSettings((s) => ({ ...s, locale: lng }));
    current = lng;
    onChange?.(current);
    return current;
  }

  ipcMain.on("app:get-locale", (event) => {
    event.returnValue = current;
  });
  ipcMain.handle("app:set-locale", (_event, lng) => applyLocale(lng));

  return { current: () => current, applyLocale };
}

module.exports = { createLocale, SUPPORTED_LOCALES };
