// The parts of a file path, for naming what the editor writes next to it.
// Either separator: a catalog made on Windows keeps its backslashes.

import { fileName } from "../../utils/format";

// The folder part, "" when the path has none.
export function parentDir(filePath) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash > 0 ? filePath.slice(0, slash) : "";
}

// { dir, name, stem, ext } — `ext` lower-cased without the dot, "" when
// there is none. Web bridge assets carry their file name URL-encoded after
// "#/", so the name is decoded.
export function pathParts(filePath) {
  let name = fileName(filePath);
  try { name = decodeURIComponent(name); } catch { /* keep as-is */ }
  const dot = name.lastIndexOf(".");
  return {
    dir: parentDir(filePath),
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}
