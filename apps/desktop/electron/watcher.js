// Watched directories — auto-import new files dropped into user-designated
// folders (e.g. an editor's export target). chokidar gives us macOS FSEvents
// (via Node's recursive fs.watch) while the app runs; the renderer handles
// catch-up (files added while closed) by re-importing each watched dir on mount.
//
// This module only DISCOVERS + debounces; it never imports directly. It sends
// `workspace:watched-import` to the renderer, which runs its normal
// addImagesFromPaths() flow (registerRoots + import job + dedup + refresh +
// requireCatalog guard) — mirrors the existing open-file (onExternalImport) bridge.

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

// Media we care about (image / video / RAW). The sidecar import is the source of
// truth and re-filters, so this is just to avoid triggering on junk.
const MEDIA_RE = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|mp4|mov|m4v|webm|cr2|cr3|crw|arw|srf|sr2|nef|nrw|raf|orf|rw2|raw|rwl|pef|ptx|dng|3fr|fff|iiq|eip|cap|mef|mos|mrw|srw|x3f|dcr|kdc|gpr|ari)$/i;

let watcher = null;
let getWindow = () => null;
let catalog = { path: () => null, read: () => ({}), update: async () => {} };
const pending = new Set();
let flushTimer = null;
let generation = 0;

function sameCatalog(left, right) {
  if (!left || !right) return left === right;
  return path.resolve(left) === path.resolve(right);
}

function send(paths, catalogPath) {
  if (!sameCatalog(catalog.path(), catalogPath)) return;
  const win = getWindow();
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send("workspace:watched-import", paths);
  }
}

function flush(eventGeneration, catalogPath) {
  flushTimer = null;
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) {
    pending.clear();
    return;
  }
  if (!pending.size) return;
  const batch = [...pending];
  pending.clear();
  send(batch, catalogPath);
}

function onAdd(filePath, eventGeneration, catalogPath) {
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) return;
  if (!MEDIA_RE.test(filePath)) return;
  if (path.basename(filePath).startsWith(".")) return; // skip dotfiles / temp
  pending.add(filePath);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(eventGeneration, catalogPath), 1000); // debounce a burst (e.g. a 200-file export)
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function watchedDirs(catalogPath = catalog.path()) {
  return (catalog.read(catalogPath)?.integrations?.watchedDirs || []).filter(Boolean);
}

// (Re)build the chokidar watcher over the current list of valid dirs.
function rebuild() {
  generation += 1;
  pending.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  const catalogPath = catalog.path();
  const dirs = watchedDirs(catalogPath).filter(isDir);
  if (!dirs.length) return;
  const eventGeneration = generation;
  watcher = chokidar.watch(dirs, {
    ignoreInitial: true, // catch-up (renderer) handles existing files
    depth: 10,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
  });
  watcher.on("add", (filePath) => onAdd(filePath, eventGeneration, catalogPath));
  watcher.on("error", (err) => console.warn("[watcher] error:", err?.message || err));
}

function register({ ipcMain, getMainWindow, getCatalogPath, readCatalogSettings, updateCatalogSettings }) {
  getWindow = getMainWindow;
  catalog = { path: getCatalogPath, read: readCatalogSettings, update: updateCatalogSettings };

  ipcMain.handle("app:get-watched-dirs", () => watchedDirs());

  ipcMain.handle("app:add-watched-dir", async (_e, dir) => {
    const d = String(dir || "");
    const catalogPath = catalog.path();
    if (catalogPath && d && isDir(d)) {
      await catalog.update((s) => {
        const cur = s?.integrations?.watchedDirs || [];
        const next = cur.includes(d) ? cur : [...cur, d];
        return { ...s, integrations: { ...(s?.integrations || {}), watchedDirs: next } };
      }, catalogPath);
      rebuild();
      send([d], catalogPath); // catch up the newly-added dir's current contents (dedup-safe)
    }
    return watchedDirs();
  });

  ipcMain.handle("app:remove-watched-dir", async (_e, dir) => {
    const d = String(dir || "");
    const catalogPath = catalog.path();
    if (!catalogPath) return [];
    await catalog.update((s) => {
      const cur = s?.integrations?.watchedDirs || [];
      return { ...s, integrations: { ...(s?.integrations || {}), watchedDirs: cur.filter((x) => x !== d) } };
    }, catalogPath);
    rebuild();
    return watchedDirs();
  });

  // For the contextual "add to watched?" toast: which of these paths are dirs.
  ipcMain.handle("app:stat-dirs", (_e, paths) => (paths || []).map(String).filter(isDir));

  return { start: rebuild, rebuild };
}

module.exports = { register };
