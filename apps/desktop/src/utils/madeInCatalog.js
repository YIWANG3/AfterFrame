// Whether a photo's file is one AfterFrame made inside the catalog folder
// (<catalog>/derived/: edits, collages, frames). Remove from Library sends
// those to the Trash (electron/derivedFiles.js, which decides by real paths),
// so its confirm says so. Matched by the catalog folder's name rather than
// its whole path: the sidecar stores paths with symlinks resolved
// (/private/var/… for /var/…), and the renderer can't resolve them.
export function madeInCatalog(filePath, catalogPath) {
  if (!filePath || !catalogPath) return false;
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const name = norm(catalogPath).split("/").pop();
  return !!name && norm(filePath).includes(`/${name}/derived/`);
}
