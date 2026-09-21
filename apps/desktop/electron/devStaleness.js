// Dev only. Vite hot-reloads the renderer, but the Electron main process and
// the Python sidecar are resident: they keep running whatever code was on disk
// when the app started. A renderer that is newer than the process it talks to
// fails quietly — an argument the old main process has never heard of is just
// dropped (a smart collection saved with no rules; every cover the same photo
// because `base` was ignored). This notices that the sources have moved on, so
// the renderer can say so and offer a restart instead of leaving it to be
// found by debugging.

const fs = require("fs");
const path = require("path");

// Keep in step with RESTART_CODE in scripts/dev-electron.mjs.
const DEV_RESTART_EXIT_CODE = 75;

const WATCHED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".py"]);
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", ".git", "dist", "build"]);

// Source files under `roots` modified after `sinceMs`, newest first.
function changedSince(roots, sinceMs, limit = 5) {
  const changed = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (WATCHED_EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.[cm]?js$/.test(entry.name)) {
        let mtimeMs;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
        if (mtimeMs > sinceMs) changed.push({ file: full, mtimeMs });
      }
    }
  };
  for (const root of roots) walk(root);
  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { stale: changed.length > 0, count: changed.length, files: changed.slice(0, limit).map((c) => c.file) };
}

function register({ ipcMain, app, roots, enabled, startedAtMs = Date.now() }) {
  ipcMain.handle("app:dev-staleness", () => {
    if (!enabled) return { stale: false, count: 0, files: [] };
    const result = changedSince(roots, startedAtMs);
    return { ...result, files: result.files.map((file) => path.relative(path.dirname(roots[0]), file)) };
  });
  // Not app.relaunch(): under `npm run dev` that would take Vite down with the
  // old process. scripts/dev-electron.mjs restarts Electron on this exit code.
  ipcMain.handle("app:relaunch", () => {
    if (!enabled) return false;
    app.exit(DEV_RESTART_EXIT_CODE);
    return true;
  });
}

module.exports = { changedSince, register, DEV_RESTART_EXIT_CODE };
