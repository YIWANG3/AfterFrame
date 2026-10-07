// The LUT library (docs/lut-plan.md §1), without Electron: plain folders of
// .cube files, scanned, so what the user does in Finder counts.
//
//  • The library folder (userData/afterframe/luts): imports are copied in,
//    subfolders are groups. Deduplicated by content on import.
//  • Folders the user adds: read where they are, never copied (a LUT pack on
//    an external drive costs nothing). Unavailable while the drive is away.
//
// A LUT's id is a hash of its absolute path: stable while it stays put, and
// what the editor and the per-LUT "Log" mark refer to. The index file caches
// each file's header (by size + mtime) so a rescan reads only what changed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./settingsStore");
const { readCubeHeader, LUT_MAX_SIZE } = require("../shared/cubeLut.mjs");
const { guessLogInput } = require("../shared/lutLogGuess.mjs");

const INDEX_VERSION = 1;
const HEADER_BYTES = 64 * 1024; // headers are a few lines; data starts early
const MAX_FILE_BYTES = 64 * 1024 * 1024; // a 65³ .cube is ~7 MB
const MAX_FILES_PER_ROOT = 5000; // someone adding their home folder
const MAX_DEPTH = 8;
const FOLDERS_MAX = 20;
const IO_CONCURRENCY = 16;

const isCube = (name) => /\.cube$/i.test(name) && !name.startsWith(".");
const lutId = (absPath) => crypto.createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 16);
const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Every .cube under `root`, as paths relative to it. Hidden entries skipped,
// symlinks not followed, bounded in depth and count.
async function walkCubes(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES_PER_ROOT) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && isCube(entry.name) && found.length < MAX_FILES_PER_ROOT) found.push(path.relative(root, full));
    }
  }
  await walk(root, 0);
  return found;
}

async function readPrefix(file, bytes) {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

// A LUT's heading in the panel: the pack (the first folder under the root)
// and the folder it sits in ("LUTIFY / ALEXA"). A vendor's deep tree in
// between says nothing, and the pack is what tells two copies apart.
// Files right in an added folder are headed by that folder's name.
function groupTitle(source, rootLabel, dirs) {
  if (!dirs.length) return source === "library" ? "" : rootLabel;
  const pack = dirs[0];
  const parent = dirs[dirs.length - 1];
  return pack === parent ? pack : `${pack} / ${parent}`;
}

// What the library needs to show without reading the table: size, title,
// a reason it can't be used, and the Log guess's inputs.
async function describe(file, stat) {
  if (stat.size > MAX_FILE_BYTES) return { lutSize: 0, title: "", error: "too_large", comments: [] };
  try {
    const header = readCubeHeader(await readPrefix(file, HEADER_BYTES));
    return { lutSize: header.size, title: header.title, error: header.error || null, comments: header.comments };
  } catch {
    return { lutSize: 0, title: "", error: "unreadable", comments: [] };
  }
}

function createLutLibrary({ libraryDir, indexPath, readFolders, writeFolders, logger = console }) {
  let index = null;
  let byId = new Map(); // id → { path, source } from the last scan

  function loadIndex() {
    if (index) return index;
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (raw?.version === INDEX_VERSION) index = { files: raw.files || {}, logMarks: raw.logMarks || {} };
    } catch {
      // Missing or unreadable: it is a cache, rebuild it.
    }
    index = index || { files: {}, logMarks: {} };
    return index;
  }

  async function saveIndex() {
    try {
      await writeJsonAtomic(indexPath, { version: INDEX_VERSION, files: index.files, logMarks: index.logMarks });
    } catch (error) {
      logger.warn?.("[luts] could not write the index:", error?.message || error);
    }
  }

  function folders() {
    const list = readFolders?.() || [];
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p).slice(0, FOLDERS_MAX) : [];
  }

  async function scanRoot(root, source, label, seen) {
    let available;
    try {
      available = (await fs.promises.stat(root)).isDirectory();
    } catch {
      available = false;
    }
    if (!available) return { available, entries: [], bytes: 0 };
    const rels = await walkCubes(root);
    let bytes = 0;
    const entries = await mapLimit(rels, IO_CONCURRENCY, async (rel) => {
      const file = path.join(root, rel);
      let stat;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        return null;
      }
      bytes += stat.size;
      seen.add(file);
      const cached = index.files[file];
      let info = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached : null;
      if (!info) {
        info = { size: stat.size, mtimeMs: stat.mtimeMs, ...(await describe(file, stat)) };
        index.files[file] = info;
      }
      const dirs = path.dirname(rel) === "." ? [] : path.dirname(rel).split(path.sep);
      const name = path.basename(rel).replace(/\.cube$/i, "");
      const id = lutId(file);
      const mark = index.logMarks[id];
      const guess = guessLogInput({ name, folders: source === "library" ? dirs : [label, ...dirs], title: info.title, comments: info.comments });
      return {
        id,
        name,
        source,
        root,
        path: file,
        group: groupTitle(source, label, dirs),
        bytes: stat.size,
        lutSize: info.lutSize,
        title: info.title,
        error: info.error,
        logGuess: guess,
        log: mark === "log" ? true : mark === "normal" ? false : !!guess,
        logMarked: mark === "log" || mark === "normal",
      };
    });
    return { available, entries: entries.filter(Boolean), bytes };
  }

  async function list() {
    loadIndex();
    const seen = new Set();
    const lib = await scanRoot(libraryDir, "library", "", seen);
    const extra = [];
    for (const folder of folders()) {
      const scanned = await scanRoot(folder, "folder", path.basename(folder) || folder, seen);
      extra.push({ folder, ...scanned });
    }
    // Forget headers of files that are gone, so the index doesn't grow forever.
    for (const file of Object.keys(index.files)) if (!seen.has(file)) delete index.files[file];
    await saveIndex();

    const sortEntries = (a, b) => naturalCompare(a.group, b.group) || naturalCompare(a.name, b.name);
    const luts = [...lib.entries.sort(sortEntries)];
    for (const f of extra) luts.push(...f.entries.sort(sortEntries));
    byId = new Map(luts.map((l) => [l.id, { path: l.path, source: l.source }]));
    return {
      library: { dir: libraryDir, count: lib.entries.length, bytes: lib.bytes },
      folders: extra.map((f) => ({
        path: f.folder, name: path.basename(f.folder) || f.folder, available: f.available, count: f.entries.length,
      })),
      luts,
    };
  }

  async function locate(id) {
    if (!byId.has(id)) await list();
    return byId.get(id) || null;
  }

  async function read(id) {
    const where = await locate(id);
    if (!where) return { error: "missing" };
    try {
      const stat = await fs.promises.stat(where.path);
      if (stat.size > MAX_FILE_BYTES) return { error: "too_large" };
      return { text: await fs.promises.readFile(where.path, "utf8") };
    } catch {
      return { error: "missing" };
    }
  }

  // Light check of a whole file before it is copied in: a usable header and
  // N³ data rows. The numbers themselves are checked when the LUT is applied
  // (parsing every value of an 800-file pack here would stall the app).
  function validate(text) {
    const header = readCubeHeader(text);
    if (header.error) return header.error;
    let rows = 0;
    for (const line of text.split(/\r\n|\r|\n/)) {
      const c = line.trimStart().charCodeAt(0);
      if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) rows += 1; // 0-9 - . +
    }
    return rows === header.size ** 3 ? null : "row_count";
  }

  // Content hashes of what is already in the library, cached in the index.
  async function libraryHashes() {
    const hashes = new Map(); // hash → path
    const rels = await walkCubes(libraryDir);
    await mapLimit(rels, IO_CONCURRENCY, async (rel) => {
      const file = path.join(libraryDir, rel);
      try {
        const stat = await fs.promises.stat(file);
        const cached = index.files[file];
        let hash = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.hash : null;
        if (!hash) {
          hash = sha1(await fs.promises.readFile(file));
          index.files[file] = { ...(cached || { size: stat.size, mtimeMs: stat.mtimeMs, ...(await describe(file, stat)) }), size: stat.size, mtimeMs: stat.mtimeMs, hash };
        }
        hashes.set(hash, file);
      } catch {
        // gone mid-scan
      }
    });
    return hashes;
  }

  function freeName(dir, base) {
    let candidate = `${base}.cube`;
    for (let n = 1; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${base} (${n}).cube`;
    return candidate;
  }

  const safeSegment = (s) => s.replace(/[/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 80) || "LUT";

  /**
   * Copies .cube files (and the .cube files inside folders) into the library.
   * A folder keeps its name as the group, plus the folder each file sat in
   * ("LUTIFY / LOG"); a file keeps the name of the folder it came from.
   * @returns {{ imported: string[], duplicates: string[], failed: {name, error}[] }} ids
   */
  async function importPaths(paths) {
    loadIndex();
    const jobs = []; // { file, group: string[] }
    for (const p of paths || []) {
      let stat;
      try {
        stat = await fs.promises.stat(p);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        for (const rel of await walkCubes(p)) {
          const parent = path.dirname(rel) === "." ? null : path.basename(path.dirname(rel));
          jobs.push({ file: path.join(p, rel), group: [path.basename(p), ...(parent ? [parent] : [])] });
        }
      } else if (stat.isFile() && isCube(path.basename(p))) {
        jobs.push({ file: p, group: [path.basename(path.dirname(p))] });
      }
    }
    const result = { imported: [], duplicates: [], failed: [] };
    if (!jobs.length) return result;
    await fs.promises.mkdir(libraryDir, { recursive: true });
    const hashes = await libraryHashes();
    for (const job of jobs) {
      const name = path.basename(job.file);
      try {
        const stat = await fs.promises.stat(job.file);
        if (stat.size > MAX_FILE_BYTES) {
          result.failed.push({ name, error: "too_large" });
          continue;
        }
        const buffer = await fs.promises.readFile(job.file);
        const hash = sha1(buffer);
        if (hashes.has(hash)) {
          result.duplicates.push(lutId(hashes.get(hash)));
          continue;
        }
        const error = validate(buffer.toString("utf8"));
        if (error) {
          result.failed.push({ name, error });
          continue;
        }
        const dir = path.join(libraryDir, ...job.group.map(safeSegment));
        await fs.promises.mkdir(dir, { recursive: true });
        const target = path.join(dir, freeName(dir, safeSegment(name.replace(/\.cube$/i, ""))));
        await fs.promises.writeFile(target, buffer, { flag: "wx" });
        hashes.set(hash, target);
        result.imported.push(lutId(target));
      } catch (error) {
        result.failed.push({ name, error: error?.code === "EACCES" ? "unreadable" : "failed" });
      }
      // Let the event loop breathe between files of a big pack.
      await new Promise((resolve) => setImmediate(resolve));
    }
    await saveIndex();
    return result;
  }

  async function addFolder(folder) {
    const resolved = path.resolve(String(folder || ""));
    try {
      if (!(await fs.promises.stat(resolved)).isDirectory()) return { error: "not_a_folder" };
    } catch {
      return { error: "not_a_folder" };
    }
    // The library folder itself, or a folder inside it, is already listed.
    if (resolved === libraryDir || resolved.startsWith(libraryDir + path.sep)) return { error: "inside_library" };
    const current = folders();
    if (!current.includes(resolved)) {
      if (current.length >= FOLDERS_MAX) return { error: "too_many_folders" };
      await writeFolders([...current, resolved]);
    }
    return { ok: true, folder: resolved };
  }

  async function removeFolder(folder) {
    await writeFolders(folders().filter((f) => f !== folder));
    return { ok: true };
  }

  async function setLogMark(id, mark) {
    loadIndex();
    if (mark === "log" || mark === "normal") index.logMarks[id] = mark;
    else delete index.logMarks[id];
    await saveIndex();
    return { ok: true };
  }

  // Only the library's own copies can be deleted from the app; a referenced
  // folder belongs to the user.
  async function libraryPath(id) {
    const where = await locate(id);
    return where?.source === "library" ? where.path : null;
  }

  return {
    libraryDir,
    list,
    read,
    importPaths,
    addFolder,
    removeFolder,
    setLogMark,
    libraryPath,
    locate,
    folders,
    forget(id) {
      byId.delete(id);
    },
  };
}

module.exports = { createLutLibrary, lutId, LUT_MAX_SIZE };
