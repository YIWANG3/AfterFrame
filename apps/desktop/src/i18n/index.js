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
import enInspector from "./locales/en/inspector.json";
import enAnnotation from "./locales/en/annotation.json";
import enEditor from "./locales/en/editor.json";
import enCollage from "./locales/en/collage.json";
import enStickerView from "./locales/en/stickerView.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhNav from "./locales/zh-CN/nav.json";
import zhInspector from "./locales/zh-CN/inspector.json";
import zhAnnotation from "./locales/zh-CN/annotation.json";
import zhEditor from "./locales/zh-CN/editor.json";
import zhCollage from "./locales/zh-CN/collage.json";
import zhStickerView from "./locales/zh-CN/stickerView.json";

export const SUPPORTED_LOCALES = ["en", "zh-CN"];

const resources = {
  en: { common: enCommon, settings: enSettings, nav: enNav, inspector: enInspector, annotation: enAnnotation, editor: enEditor, collage: enCollage, stickerView: enStickerView },
  "zh-CN": { common: zhCommon, settings: zhSettings, nav: zhNav, inspector: zhInspector, annotation: zhAnnotation, editor: zhEditor, collage: zhCollage, stickerView: zhStickerView },
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
  ns: ["common", "settings", "nav", "inspector", "annotation", "editor", "collage", "stickerView"],
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled and registered synchronously, so there's nothing to
  // suspend on — and Suspense would remount subtrees on changeLanguage (which
  // detached live elements like the language <select> mid-interaction).
  react: { useSuspense: false },
});

export default i18n;
