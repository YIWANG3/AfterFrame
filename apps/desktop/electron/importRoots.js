// Which of the paths an import names become catalog roots. A folder always
// does, whatever it holds: the sidecar walks it and counts what it leaves out
// (docs/format-support-plan.md §4.4). A file does only when the catalog
// imports its type: a .docx dropped on the window used to be registered as an
// image root and sit in the roots list forever. What is dropped here still
// reaches the import, whose summary reports it as skipped.

const fs = require("node:fs");
const { isImportable } = require("../shared/formats.mjs");

function importableRoots(paths, { statSync = fs.statSync } = {}) {
  return paths.filter((targetPath) => {
    try {
      if (statSync(targetPath).isDirectory()) return true;
    } catch {
      return true; // gone, or unreadable: the sidecar reports that itself
    }
    return isImportable(targetPath);
  });
}

module.exports = { importableRoots };
