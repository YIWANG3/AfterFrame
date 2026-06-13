// Renderer-side i18n (react-i18next). The Electron menu/native dialogs run in
// the main process and have their own tiny translator under electron/i18n/.
//
// Locale is owned by the main process (persisted in its settings.json) so the
// menu and the renderer never disagree. We read it synchronously at startup via
// the preload bridge so the very first render is already in the right language.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import enSettings from "./locales/en/settings.json";
import enNav from "./locales/en/nav.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhNav from "./locales/zh-CN/nav.json";

export const SUPPORTED_LOCALES = ["en", "zh-CN"];

const resources = {
  en: { common: enCommon, settings: enSettings, nav: enNav },
  "zh-CN": { common: zhCommon, settings: zhSettings, nav: zhNav },
};

function initialLocale() {
  try {
    const fromMain = window.mediaWorkspace?.getInitialLocale?.();
    if (fromMain && SUPPORTED_LOCALES.includes(fromMain)) return fromMain;
  } catch { /* preload not ready (tests) — fall back */ }
  return "en";
}

i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: ["common", "settings", "nav"],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
