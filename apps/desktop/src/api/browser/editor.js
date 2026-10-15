// What the editor asks the bridge for: frame logos, user frame templates,
// personal logos, stickers, text images.

// Frame logos: same static assets the desktop reads from disk
// (electron/ipc/frameLogos.js), bundled at build time the way frame-lab.js
// does. Keys mirror the desktop shape: file paths relative to frame-logos/.
import frameLogoManifest from "/frame-logos/logos.json";
const frameLogoGlob = import.meta.glob("/frame-logos/**/*.svg", { query: "?raw", import: "default", eager: true });
const frameLogoSvgs = Object.fromEntries(
  Object.entries(frameLogoGlob).map(([k, v]) => [k.replace("/frame-logos/", ""), v]),
);

const TEMPLATES_KEY = "afterframe.frameTemplates";

export const editorMethods = {
  getFrameLogos: async () => ({ manifest: frameLogoManifest, svgs: frameLogoSvgs }),
  // User frame templates: this browser only.
  listFrameTemplates: async () => {
    try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY)) || []; } catch { return []; }
  },
  saveFrameTemplates: async (templates) => {
    const next = (Array.isArray(templates) ? templates : []).filter((t) => t?.kind === "layers" && String(t.id || "").startsWith("user:"));
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next));
    return next;
  },
  // No file import in the browser: its logo list stays empty.
  listPersonalLogos: async () => ({ logos: [] }),
  stickerList: async () => [],
  getTextImageStatus: async () => null,
};
