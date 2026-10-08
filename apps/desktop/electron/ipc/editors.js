// External-editor integration — detect installed photo editors and open the
// user's selected files in them. Format-agnostic: opens the original file(s)
// as-is (the external app decodes its own formats, incl. RAW).

const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");

// Built-in editors to auto-detect, matched against the .app bundle name on
// macOS and the Start menu shortcut's name on Windows (case-insensitive
// prefix). Version suffixes (e.g. "Adobe Photoshop 2025") are covered by
// matching the prefix.
const KNOWN_EDITORS = [
  { label: "Photoshop", re: /^adobe photoshop/i },
  { label: "Lightroom Classic", re: /^adobe lightroom classic/i },
  { label: "Lightroom", re: /^adobe lightroom(?! classic)/i },
  { label: "像素蛋糕", re: /^(像素蛋糕|pixcake)/i },
  { label: "Affinity Photo", re: /^affinity photo/i },
  { label: "Pixelmator Pro", re: /^pixelmator/i },
  { label: "Photomator", re: /^photomator/i },
  { label: "GIMP", re: /^gimp/i },
  { label: "Preview", re: /^preview$/i },
];

// Collect .app bundles in a dir AND one level deeper — Adobe installs e.g.
// Photoshop/Lightroom inside a per-app subfolder
// (/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app).
function collectApps(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.toLowerCase().endsWith(".app")) {
      out.push({ name: entry.slice(0, -4), appPath: full });
    } else {
      let sub;
      try { sub = fs.readdirSync(full); } catch { continue; }
      for (const s of sub) {
        if (s.toLowerCase().endsWith(".app")) {
          out.push({ name: s.slice(0, -4), appPath: path.join(full, s) });
        }
      }
    }
  }
}

// Windows has no one folder of apps, and each vendor installs its own way
// (Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe, GIMP 2\bin\…). What
// they all leave is a Start menu shortcut named as the editor calls itself
// ("Adobe Photoshop 2026", "像素蛋糕"), here and in a vendor folder below it.
// The shortcut gives the .exe it starts.
function startMenuDirs(env = process.env) {
  return [env.ProgramData, env.APPDATA]
    .filter(Boolean)
    .map((root) => path.join(root, "Microsoft", "Windows", "Start Menu", "Programs"));
}

function collectShortcuts(dir, out, readShortcutLink, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 2) collectShortcuts(full, out, readShortcutLink, depth + 1);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".lnk")) continue;
    let target;
    try { target = readShortcutLink(full)?.target; } catch { continue; }
    if (target && target.toLowerCase().endsWith(".exe") && fs.existsSync(target)) {
      out.push({ name: entry.name.slice(0, -4), appPath: target });
    }
  }
}

function defaultReadShortcutLink(file) {
  return require("electron").shell.readShortcutLink(file);
}

function detectEditors({ platform = process.platform, env = process.env, readShortcutLink = defaultReadShortcutLink } = {}) {
  const candidates = [];
  if (platform === "win32") {
    for (const dir of startMenuDirs(env)) collectShortcuts(dir, candidates, readShortcutLink);
  } else {
    collectApps("/Applications", candidates);
    collectApps(path.join(os.homedir(), "Applications"), candidates);
  }
  const byLabel = new Map();
  for (const known of KNOWN_EDITORS) {
    const matches = candidates.filter((c) => known.re.test(c.name));
    if (!matches.length) continue;
    // Prefer the highest-sorting name → latest version (2026 > 2024).
    matches.sort((a, b) => a.name.localeCompare(b.name));
    byLabel.set(known.label, matches[matches.length - 1].appPath);
  }
  return [...byLabel.entries()].map(([label, appPath]) => ({ label, appPath }));
}

// Windows hands the files to the editor on its command line, which can't be
// longer than 32K characters: a large selection goes in several launches, and
// a running editor takes the later ones in.
const WINDOWS_COMMAND_LINE_BUDGET = 30_000;

function commandLineBatches(appPath, files, budget = WINDOWS_COMMAND_LINE_BUDGET) {
  const batches = [];
  let batch = [];
  let length = appPath.length + 3;
  for (const file of files) {
    const cost = file.length + 3; // the quotes and the space around it
    if (batch.length && length + cost > budget) {
      batches.push(batch);
      batch = [];
      length = appPath.length + 3;
    }
    batch.push(file);
    length += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function openOnWindows(appPath, files, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let pending = 0;
    let failure = null;
    const batches = commandLineBatches(appPath, files);
    for (const batch of batches) {
      pending += 1;
      let child;
      try {
        child = spawnProcess(appPath, batch, { detached: true, stdio: "ignore" });
      } catch (err) {
        failure = failure || err;
        pending -= 1;
        continue;
      }
      // 'spawn' or 'error' says whether it started; the editor keeps running.
      child.once("spawn", () => { if (--pending === 0) finish(); });
      child.once("error", (err) => { failure = failure || err; if (--pending === 0) finish(); });
      child.unref();
    }
    if (pending === 0) finish();
    function finish() {
      if (failure) {
        console.error("[open-in-editor] failed:", failure.message);
        resolve({ ok: false, error: failure.message });
      } else {
        resolve({ ok: true, count: files.length });
      }
    }
  });
}

function register({ ipcMain }) {
  ipcMain.handle("app:detect-editors", () => {
    try { return detectEditors(); } catch (err) {
      console.warn("[detect-editors] failed:", err.message);
      return [];
    }
  });

  // Open the given files in the app (by .app path on macOS, .exe on Windows).
  // macOS `open -a` launches the app (or brings it forward) with all files as
  // arguments — multi-select opens them together.
  ipcMain.handle("app:open-in-editor", (_event, filePaths, appPath) => {
    const files = (filePaths || []).map(String).filter(Boolean).filter((p) => fs.existsSync(p));
    if (!files.length || !appPath) return Promise.resolve({ ok: false });
    if (process.platform === "win32") return openOnWindows(String(appPath), files);
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

module.exports = { register, detectEditors, commandLineBatches, openOnWindows, startMenuDirs };
