// Files AfterFrame made itself inside the catalog folder, in <catalog>/derived/:
// edits, crops, text, collages and frames (the sidecar's derived.py and the
// MCP render tools). Removing such a photo from the library sends its file to
// the Trash too. Once the record is gone nothing points at the file, and
// nothing outside the app shows that folder, so it only took room: removed
// photos' files stayed there forever (review 2026-11-27, disk growth). An
// original the user imported is never touched; Delete from Disk is for those.

const fs = require("node:fs");
const path = require("node:path");

// The real path, symlinks (and Windows' short names) resolved. A file that is
// gone gets its nearest existing folder's real path with the rest appended,
// so it compares like one that is still there.
function realOrResolved(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

// Whether `filePath` is inside the catalog's derived folder.
function isDerivedFile(filePath, catalogPath) {
  if (!filePath || !catalogPath) return false;
  const rel = path.relative(realOrResolved(path.join(catalogPath, "derived")), realOrResolved(filePath));
  return rel !== "" && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
}

// Removes the assets from the catalog, then trashes the files AfterFrame made
// for the ones removed. Resolves the sidecar's rows, as a removal did before.
// A file that can't be trashed stays where it was, as every file used to.
async function removeFromLibrary({ commands, assetIds, catalogPath, trashItem }) {
  const rows = await commands.deleteImageAssets(assetIds);
  for (const row of rows || []) {
    const file = row?.image_path;
    if (!isDerivedFile(file, catalogPath) || !fs.existsSync(file)) continue;
    try {
      await trashItem(file);
    } catch (err) {
      console.warn("[derived] couldn't move to the Trash:", file, err?.message || err);
    }
  }
  return rows;
}

module.exports = { isDerivedFile, removeFromLibrary };
