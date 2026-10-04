// A watched-folder import of many files goes to the importer as their folders.
// One argument per file (register-roots, then the import job's argv) broke at
// tens of thousands: the catch-up after an interrupted drive import replayed
// 20k files per launch (#130). Only for watched folders, where importing the
// whole folder is what the user asked for; a drop of chosen files stays as is.
// Mirrors electron/watcher.js importTargets.
export function importTargets(files, limit = 500) {
  if (files.length <= limit) return files;
  const parent = (file) => file.replace(/[\\/][^\\/]*$/, "");
  const under = (dir, outer) => dir.startsWith(outer) && /[\\/]/.test(dir[outer.length] || "");
  const kept = [];
  for (const dir of [...new Set(files.map(parent))].sort()) {
    if (!kept.some((outer) => under(dir, outer))) kept.push(dir);
  }
  return kept;
}
