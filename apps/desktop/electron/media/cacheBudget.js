// Least-recently-used trimming for the caches the app keeps under userData
// (rendered originals, video proxies, hover filmstrips, depth maps). Each
// keeps its most recently used entries within a byte budget, so a long-lived
// install does not grow them without end (review 2026-11-27, disk growth).
//
// An entry is one file or, for a cache that keeps a folder per item (the
// filmstrips), one folder, sized by the files in it. "Used" is the entry's
// mtime: a cache touches an entry when it serves it from disk, and a new one
// is written now. Names starting with a dot (a render being written) are not
// entries.

const path = require("node:path");
const fs = require("node:fs");

function sizeOf(entryPath, stat) {
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of fs.readdirSync(entryPath)) {
    const child = path.join(entryPath, name);
    try {
      total += sizeOf(child, fs.statSync(child));
    } catch {
      /* gone while we looked */
    }
  }
  return total;
}

// Deletes the least recently used entries of `dir` until the rest fit
// `budgetBytes`, and returns their paths. `keep` lists entries never deleted
// (the one just written: a single clip bigger than the budget stays until the
// next one); `include(name)` narrows what counts as an entry.
function pruneToBudget(dir, budgetBytes, { keep = [], include = () => true } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const kept = new Set(keep.map((p) => path.resolve(p)));
  const entries = [];
  for (const name of names) {
    if (name.startsWith(".") || !include(name)) continue;
    const entryPath = path.join(dir, name);
    try {
      const stat = fs.statSync(entryPath);
      entries.push({ path: entryPath, size: sizeOf(entryPath, stat), mtime: stat.mtimeMs });
    } catch {
      /* gone while we looked */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  const stale = [];
  for (const entry of entries) {
    total += entry.size;
    if (total > budgetBytes && !kept.has(path.resolve(entry.path))) stale.push(entry.path);
  }
  for (const entryPath of stale) fs.rmSync(entryPath, { recursive: true, force: true });
  return stale;
}

// Marks an entry as just used.
function touch(entryPath) {
  try {
    const now = new Date();
    fs.utimesSync(entryPath, now, now);
  } catch {
    /* gone: nothing to mark */
  }
}

module.exports = { pruneToBudget, touch };
