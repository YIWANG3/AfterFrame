// External-editor integration — detect installed photo editors and open the
// user's selected files in them. Format-agnostic: opens the original file(s)
// as-is (the external app decodes its own formats, incl. RAW).

const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// Built-in editors to auto-detect, matched against the .app bundle name
// (case-insensitive prefix). Version suffixes (e.g. "Adobe Photoshop 2025")
// are covered by matching the prefix.
const KNOWN_EDITORS = [
  { label: "Photoshop", re: /^adobe photoshop/i },
  { label: "像素蛋糕", re: /^(像素蛋糕|pixcake)/i },
  { label: "Affinity Photo", re: /^affinity photo/i },
  { label: "Pixelmator Pro", re: /^pixelmator/i },
  { label: "Photomator", re: /^photomator/i },
  { label: "GIMP", re: /^gimp/i },
  { label: "Preview", re: /^preview$/i },
];

function detectEditors() {
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const found = new Map(); // label -> appPath (first match wins)
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".app")) continue;
      const name = entry.slice(0, -4);
      for (const known of KNOWN_EDITORS) {
        if (!found.has(known.label) && known.re.test(name)) {
          found.set(known.label, path.join(dir, entry));
        }
      }
    }
  }
  return [...found.entries()].map(([label, appPath]) => ({ label, appPath }));
}

function register({ ipcMain }) {
  ipcMain.handle("app:detect-editors", () => {
    try { return detectEditors(); } catch (err) {
      console.warn("[detect-editors] failed:", err.message);
      return [];
    }
  });

  // Open the given files in the app (by .app path). macOS `open -a` launches the
  // app (or brings it forward) with all files as arguments — multi-select opens
  // them together.
  ipcMain.handle("app:open-in-editor", (_event, filePaths, appPath) => {
    const files = (filePaths || []).map(String).filter(Boolean).filter((p) => fs.existsSync(p));
    if (!files.length || !appPath) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      execFile("open", ["-a", String(appPath), ...files], (err) => {
        if (err) {
          console.error("[open-in-editor] failed:", err.message);
          resolve({ ok: false, error: err.message });
        } else {
          resolve({ ok: true, count: files.length });
        }
      });
    });
  });
}

module.exports = { register, detectEditors };
