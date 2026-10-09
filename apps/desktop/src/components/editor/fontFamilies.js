// The font families installed on this machine, for the font picker and for
// checking that a remembered font is still there. Chromium's queryLocalFonts
// where it works (packaged Electron), else the main process's list. The last
// answer is kept: the picker asks again each time it opens, so a font
// installed while the app runs shows up.

import api from "../../api";
import { FONT_OPTIONS } from "./textState";

let known = null;

export async function loadSystemFontFamilies() {
  try {
    if (window.queryLocalFonts) {
      const fontData = await window.queryLocalFonts();
      known = [...new Set(fontData.map((f) => f.family))].sort();
      return known;
    }
  } catch { /* no permission, or not supported: ask main */ }
  try {
    const fonts = await api.listSystemFonts();
    if (Array.isArray(fonts)) known = fonts;
  } catch { /* none listed */ }
  return known || [];
}

// Bundled, or installed as of the last listing. Before any listing has
// answered, a family counts as there: rendering falls back on its own.
export function fontFamilyAvailable(family) {
  if (FONT_OPTIONS.some((f) => f.family === family)) return true;
  return known ? known.includes(family) : true;
}
