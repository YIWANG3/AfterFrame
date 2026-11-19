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
// sidecar drops the files the catalog already holds as they are. Those go to
// the renderer as `workspace:watched-present` (their asset ids) instead: a
// photo moved out and put back unchanged is one of them, and a card that saw
// it gone re-checks.

const fs = require("fs");
const path = require("path");

// Media we care about (image / video / RAW): what the import takes, from the
// format registry. The sidecar re-filters; this only avoids triggering on junk.
const { MEDIA_RE } = require("../shared/formats.mjs");

// An XMP sidecar is Lightroom's (Bridge's, darktable's) way of re-rating a
// RAW without touching it: its change is its photo's change. IMG.CR2.xmp
// (darktable) names the photo; IMG.xmp (Adobe) is the photo's stem, and
// stands for every media file of that stem beside it (the RAW and its JPEG).
const SIDECAR_RE = /\.xmp$/i;

function photosOfSidecar(filePath) {
  const bare = filePath.slice(0, -".xmp".length);
  if (MEDIA_RE.test(bare)) return [bare];
  const dir = path.dirname(bare);
  const stem = path.basename(bare).toLowerCase();
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => MEDIA_RE.test(name) && path.parse(name).name.toLowerCase() === stem)
    .map((name) => path.join(dir, name));
}

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
const checkNone = async () => null;

let watchers = [];
let getWindow = () => null;
let catalog = { path: () => null, read: () => ({}), update: async () => {}, changed: keepAll, verify: checkNone };
const pending = new Set();
// Paths fs.watch reported that are not media files: a folder that arrived (a
// shoot moved in, a folder renamed) or one that went (moved out, deleted).
const pendingDirs = new Set();
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

function send(channel, payload, catalogPath) {
  if (!sameCatalog(catalog.path(), catalogPath)) return;
  const win = getWindow();
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// Does a folder hold a photo or video anywhere inside? A new empty folder
// (Finder's "untitled folder") is nothing to import. Gives up looking after
// `budget` entries and says yes: the import itself finds out.
function holdsMedia(dir, budget = { left: 5000 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (--budget.left <= 0) return true;
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && MEDIA_RE.test(entry.name)) return true;
    if (entry.isDirectory() && holdsMedia(path.join(dir, entry.name), budget)) return true;
  }
  return false;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// The files an import would change, and the assets of those the catalog holds
// as they are on disk. A batch the sidecar can't answer for is kept: the
// import itself skips what hasn't changed.
async function checkFiles(files) {
  const changed = [];
  const present = [];
  for (let start = 0; start < files.length; start += MAX_FILES_PER_IMPORT) {
    const batch = files.slice(start, start + MAX_FILES_PER_IMPORT);
    try {
      const result = await catalog.changed(batch);
      changed.push(...(Array.isArray(result?.changed) ? result.changed : batch));
      if (Array.isArray(result?.present_asset_ids)) present.push(...result.present_asset_ids);
    } catch (err) {
      console.warn("[watcher] can't check for changes:", err?.message || err);
      changed.push(...batch);
    }
  }
  return { changed, present };
}

// What left a synced folder: the photos whose files went (`files`) or that
// were in a folder that went (`dirs`) are checked, so they show as missing.
// A file moved within the folder arrives too; its import relinks the record
// (db.maintenance.claim_moved_original), whatever order the two come in.
async function verifyGone(files, dirs) {
  let missing = 0;
  try {
    if (files.length) missing += (await catalog.verify({ paths: files }))?.newly_missing || 0;
    for (const dir of dirs) missing += (await catalog.verify({ under: dir }))?.newly_missing || 0;
  } catch (err) {
    console.warn("[watcher] can't check what went:", err?.message || err);
  }
  return missing;
}

async function flush(eventGeneration, catalogPath) {
  flushTimer = null;
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) {
    pending.clear();
    pendingDirs.clear();
    return;
  }
  // fs.watch reports a deletion like a creation ('rename'): what exists came
  // or changed, what doesn't went.
  const reported = [...pending];
  const reportedDirs = [...pendingDirs];
  pending.clear();
  pendingDirs.clear();
  const files = reported.filter(isFile);
  const gone = reported.filter((file) => !fs.existsSync(file));
  // A folder reported along with a file inside it was only written to (its
  // own change follows the file's); one that arrived is reported alone.
  const arrivedDirs = reportedDirs.filter((dir) => isDir(dir) && !reported.some((file) => isInside(file, dir)) && holdsMedia(dir));
  const goneDirs = reportedDirs.filter((dir) => !fs.existsSync(dir));
  if (gone.length || goneDirs.length) {
    const missing = await verifyGone(gone, goneDirs);
    if (eventGeneration !== generation) return;
    if (missing) send("workspace:catalog-changed", { scope: "assets", reason: "watcher" }, catalogPath);
  }
  if (!files.length && !arrivedDirs.length) return;
  const { changed, present } = files.length ? await checkFiles(files) : { changed: [], present: [] };
  if (eventGeneration !== generation) return;
  // A folder that arrived goes to the import whole: the import skips what it holds already.
  const targets = [...importTargets(changed), ...arrivedDirs];
  if (targets.length) send("workspace:watched-import", importTargets(targets), catalogPath);
  if (present.length) send("workspace:watched-present", present, catalogPath);
}

// `relative` is the changed path under `root`, as fs.watch reports it.
function onChange(root, relative, eventGeneration, catalogPath) {
  if (eventGeneration !== generation || !sameCatalog(catalog.path(), catalogPath)) return;
  if (!relative) return;
  const name = String(relative);
  const sidecar = SIDECAR_RE.test(name);
  // Hidden files and folders: temp files, .Trashes, .Spotlight-V100, editors' scratch.
  if (name.split(/[\\/]/).some((part) => part.startsWith("."))) return;
  const filePath = path.join(root, name);
  // A catalog kept inside a watched folder writes its own previews there.
  if (catalogPath && isInside(filePath, catalogPath)) return;
  if (!sidecar && !MEDIA_RE.test(name)) {
    // No extension: a folder that came or went (a file of another type that
    // exists is left alone). FSEvents also reports the watched folder itself
    // by its own name, which is no folder inside it.
    if (path.extname(name) || isFile(filePath)) return;
    if (name === path.basename(root) && !fs.existsSync(filePath)) return;
    pendingDirs.add(filePath);
  } else {
    const files = sidecar ? photosOfSidecar(filePath) : [filePath];
    if (!files.length) return;
    for (const file of files) pending.add(file);
  }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(eventGeneration, catalogPath), quietMs);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function hasSubfolder(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).some((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  } catch { return false; }
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
  pendingDirs.clear();
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

function register({
  ipcMain, getMainWindow, catalog: { path: getCatalogPath }, readCatalogSettings, updateCatalogSettings,
  // The sidecar's changed-media filter; a test without a sidecar keeps every path.
  commands = null, changedMedia = commands ? (paths) => commands.changedMedia(paths) : keepAll,
  // Marks what left a synced folder missing (verify-assets for those paths).
  verifyMedia = commands ? (options) => commands.verifyAssets(options) : checkNone,
  quietPeriodMs = QUIET_MS,
}) {
  getWindow = getMainWindow;
  catalog = { path: getCatalogPath, read: readCatalogSettings, update: updateCatalogSettings, changed: changedMedia, verify: verifyMedia };
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
      send("workspace:watched-import", [d], catalogPath); // catch up the newly-added dir's current contents (dedup-safe)
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
  // A folder dropped on the sidebar asks whether to keep its subfolders only
  // when it has some: which of these folders hold a folder (not a hidden one).
  ipcMain.handle("app:dirs-with-subfolders", (_e, paths) => (paths || []).map(String).filter(hasSubfolder));

  return { start: rebuild, rebuild, stop: close, watchedDirs, addWatchedDir, removeWatchedDir };
}

module.exports = { photosOfSidecar, register, importTargets, hasSubfolder };
