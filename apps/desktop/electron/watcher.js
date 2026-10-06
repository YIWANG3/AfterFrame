// Watched directories — auto-import new files and re-index overwritten files in
// user-designated folders (e.g. an editor's export target) while the app runs;
// the renderer handles catch-up (files added while closed) on mount.
//
// One recursive fs.watch per watched folder: FSEvents on macOS and
// ReadDirectoryChangesW on Windows, a single handle for the whole tree. The
// chokidar watcher this replaces (v5 has no fsevents backend) held a file
// descriptor for every file under the folder: watching an imported 2 TB drive
// ran the main process out of descriptors, after which it couldn't start a
// sidecar or read the catalog, on every launch (#130).
//
// This module only DISCOVERS + debounces; it never imports directly. It sends
// `workspace:watched-import` to the renderer, which runs its normal
// addImagesFromPaths() flow (registerRoots + import job + dedup + refresh +
// requireCatalog guard) — mirrors the existing open-file (onExternalImport) bridge.
//
// A folder reports more than new and rewritten files. AirDropping a photo, a
// Finder tag or opening it in another app writes only its extended attributes,
// and importing for those runs a job with nothing to do. Before sending, the
// sidecar drops the files the catalog already holds as they are.

const fs = require("fs");
const path = require("path");

// Media we care about (image / video / RAW). The sidecar import is the source of
// truth and re-filters, so this is just to avoid triggering on junk.
const MEDIA_RE = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|mp4|mov|m4v|webm|cr2|cr3|crw|arw|srf|sr2|nef|nrw|raf|orf|rw2|raw|rwl|pef|ptx|dng|3fr|fff|iiq|eip|cap|mef|mos|mrw|srw|x3f|dcr|kdc|gpr|ari)$/i;

// A burst of writes (an editor exporting 200 files) is imported once it has
// been quiet this long. Editor exports can pause between chunks; the sidecar
// also validates JPEG completeness and source stability, so a longer pause
// still cannot publish a partial preview.
const QUIET_MS = 3000;
// More files than this go to the importer as their folders: a path per file
// would make one argv/IPC argument per file (tens of thousands after copying
// a card into a watched folder).
const MAX_FILES_PER_IMPORT = 500;

const keepAll = async (paths) => ({ changed: paths });

let watchers = [];
let getWindow = () => null;
let catalog = { path: () => null, read: () => ({}), update: async () => {}, changed: keepAll };
const pending = new Set();
let flushTimer = null;
let generation = 0;
let quietMs = QUIET_MS;

function sameCatalog(left, right) {
  if (!left || !right) return left === right;
  return path.resolve(left) === path.resolve(right);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// Files, or their folders when there are too many to pass one by one.
// Nested folders collapse into their outermost one.
function importTargets(files, limit = MAX_FILES_PER_IMPORT) {
  if (files.length <= limit) return files;
  const dirs = [...new Set(files.map((file) => path.dirname(file)))].sort();
  return dirs.filter((dir, index) => !dirs.slice(0, index).some((outer) => isInside(dir, outer)));
}

function send(paths, catalogPath) {
  if (!sameCatalog(catalog.path(), catalogPath)) return;
  const win = getWindow();
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send("workspace:watched-import", paths);
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// The files an import would change. A batch the sidecar can't answer for is
// kept: the import itself skips what hasn't changed.
async function changedFiles(files) {
  const changed = [];
  for (let start = 0; start < files.length; start += MAX_FILES_PER_IMPORT) {
    const batch = files.slice(start, start + MAX_FILES_PER_IMPORT);
    try {
      const result = await catalog.changed(batch);
      changed.push(...(Array.isArray(result?.changed) ? result.changed : batch));
    } catch (err) {
      console.warn("[watcher] can't check for changes:", err?.message || err);
      changed.push(...batch);
    }
  }
  return changed;
}

async function flush(eventGeneration, catalogPath) {
  flushTimer = null;
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) {
    pending.clear();
    return;
  }
  // fs.watch reports a deletion like a creation ('rename'): keep what exists.
  const files = [...pending].filter(isFile);
  pending.clear();
  if (!files.length) return;
  const changed = await changedFiles(files);
  if (eventGeneration !== generation) return;
  if (changed.length) send(importTargets(changed), catalogPath);
}

// `relative` is the changed path under `root`, as fs.watch reports it.
function onChange(root, relative, eventGeneration, catalogPath) {
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) return;
  if (!relative) return;
  const name = String(relative);
  if (!MEDIA_RE.test(name)) return;
  // Hidden files and folders: temp files, .Trashes, .Spotlight-V100, editors' scratch.
  if (name.split(/[\\/]/).some((part) => part.startsWith("."))) return;
  const filePath = path.join(root, name);
  // A catalog kept inside a watched folder writes its own previews there.
  if (catalogPath && isInside(filePath, catalogPath)) return;
  pending.add(filePath);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(eventGeneration, catalogPath), quietMs);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function watchedDirs(catalogPath = catalog.path()) {
  return (catalog.read(catalogPath)?.integrations?.watchedDirs || []).filter(Boolean);
}

function close() {
  for (const watcher of watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  watchers = [];
}

// (Re)build one recursive watcher per valid watched dir.
function rebuild() {
  generation += 1;
  pending.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  close();
  const catalogPath = catalog.path();
  const dirs = watchedDirs(catalogPath).filter(isDir);
  const eventGeneration = generation;
  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, relative) => (
        onChange(dir, relative, eventGeneration, catalogPath)
      ));
      watcher.on("error", (err) => console.warn("[watcher] error:", dir, err?.message || err));
      watchers.push(watcher);
    } catch (err) {
      console.warn("[watcher] can't watch", dir, err?.message || err);
    }
  }
}

function register({ ipcMain, getMainWindow, getCatalogPath, readCatalogSettings, updateCatalogSettings, changedMedia = keepAll, quietPeriodMs = QUIET_MS }) {
  getWindow = getMainWindow;
  catalog = { path: getCatalogPath, read: readCatalogSettings, update: updateCatalogSettings, changed: changedMedia };
  quietMs = quietPeriodMs;

  // Named (not inline in the handlers) so the MCP maintain_library tool can
  // manage watched dirs through the same code path as the settings UI.
  async function addWatchedDir(dir) {
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
  }

  async function removeWatchedDir(dir) {
    const d = String(dir || "");
    const catalogPath = catalog.path();
    if (!catalogPath) return [];
    await catalog.update((s) => {
      const cur = s?.integrations?.watchedDirs || [];
      return { ...s, integrations: { ...(s?.integrations || {}), watchedDirs: cur.filter((x) => x !== d) } };
    }, catalogPath);
    rebuild();
    return watchedDirs();
  }

  ipcMain.handle("app:get-watched-dirs", () => watchedDirs());
  ipcMain.handle("app:add-watched-dir", (_e, dir) => addWatchedDir(dir));
  ipcMain.handle("app:remove-watched-dir", (_e, dir) => removeWatchedDir(dir));

  // For the contextual "add to watched?" toast: which of these paths are dirs.
  ipcMain.handle("app:stat-dirs", (_e, paths) => (paths || []).map(String).filter(isDir));

  return { start: rebuild, rebuild, stop: close, watchedDirs, addWatchedDir, removeWatchedDir };
}

module.exports = { register, importTargets };
