// Settings kept in this browser: the locale, rebound shortcuts, preview
// settings, the watermark profile (author, brand logos, camera names).

const SHORTCUTS_KEY = "afterframe.shortcuts";
const WATERMARK_KEY = "afterframe.watermarkProfile";

// Read synchronously at i18n import time. Settings → General persists the
// choice; first visit follows the browser.
export function getInitialLocale() {
  try {
    const saved = localStorage.getItem("afterframe.locale");
    if (saved) return saved;
  } catch { /* fall through */ }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function readWatermarkProfile() {
  try {
    const stored = JSON.parse(localStorage.getItem(WATERMARK_KEY)) || {};
    const map = (value) => (value && typeof value === "object" ? value : {});
    return { author: String(stored.author || ""), brandLogos: map(stored.brandLogos), cameraNames: map(stored.cameraNames) };
  } catch {
    return { author: "", brandLogos: {}, cameraNames: {} };
  }
}

function writeWatermarkProfile(next) {
  localStorage.setItem(WATERMARK_KEY, JSON.stringify(next));
  return next;
}

export const settingsMethods = {
  // ── locale ──
  getInitialLocale,
  setLocale: (locale) => {
    try { localStorage.setItem("afterframe.locale", String(locale)); } catch { /* session-only */ }
  },

  // ── previews ──
  getPreviewSettings: async () => ({ generateHd: false }),
  savePreviewSettings: async () => {},

  // ── rebound keyboard shortcuts (overrides only; see shared/shortcuts.mjs) ──
  getShortcuts: async () => {
    try { return JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || "{}"); } catch { return {}; }
  },
  saveShortcuts: async (overrides) => {
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(overrides || {})); } catch { /* private mode */ }
    return overrides || {};
  },

  // ── watermark profile: this browser only ──
  getWatermarkProfile: async () => readWatermarkProfile(),
  saveWatermarkProfile: async (profile) => {
    const current = readWatermarkProfile();
    return writeWatermarkProfile({
      author: String(profile?.author ?? current.author).replace(/\s+/g, " ").trim().slice(0, 80),
      brandLogos: profile?.brandLogos && typeof profile.brandLogos === "object" ? { ...profile.brandLogos } : current.brandLogos,
      cameraNames: profile?.cameraNames && typeof profile.cameraNames === "object" ? { ...profile.cameraNames } : current.cameraNames,
    });
  },
  setBrandLogo: async (brandKey, logoId) => {
    const current = readWatermarkProfile();
    const brandLogos = { ...current.brandLogos };
    if (logoId) brandLogos[String(brandKey)] = String(logoId);
    else delete brandLogos[String(brandKey)];
    return writeWatermarkProfile({ ...current, brandLogos });
  },
  setCameraName: async (key, name) => {
    const current = readWatermarkProfile();
    const cameraNames = { ...current.cameraNames };
    const clean = typeof name === "string" ? name.trim() : "";
    if (clean) cameraNames[String(key)] = clean.slice(0, 40);
    else delete cameraNames[String(key)];
    return writeWatermarkProfile({ ...current, cameraNames });
  },
};
