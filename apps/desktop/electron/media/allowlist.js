// The media:// allowlist. The media: protocol (and the localhost video
// server) must only serve files the app legitimately knows about: the catalog
// (previews/derived), registered raw/export roots, app data (sticker library),
// the HEIC transcode cache, and directories the app itself just wrote into
// (editor saves). Anything else is a renderer-compromise escalation to full
// disk read. Extracted from main.js (review 2026-09-16 §2); the path rules
// are unit-tested, the protocol wiring lives in ./protocol.js.
//   getCatalogPath / catalogHasDb   the open catalog (its whole tree is allowed)
//   loadCatalogRoots                async () => [{ path }] — registered roots,
//                                   loaded lazily once per catalog
//   realpath                        fs.realpathSync.native by default; injected
//                                   so tests can model symlinks without a disk

const path = require("node:path");
const fs = require("node:fs");

function createMediaAllowlist({ getCatalogPath, catalogHasDb, loadCatalogRoots, realpath = fs.realpathSync.native, isDirectory = (p) => fs.statSync(p).isDirectory() }) {
  const allowedMediaDirs = new Set();
  const baselineMediaDirs = []; // catalog-independent entries, survive resets
  let mediaRootsLoaded = null; // promise — lazily refreshed per catalog

  // Symlink-safe canonical form. On macOS /var → /private/var, /tmp → /private/tmp:
  // the sidecar emits realpath'd absolute paths while config strings keep the
  // symlinked form — naive prefix comparison 403's entire catalogs under /tmp.
  function canonicalize(p) {
    const resolved = path.resolve(String(p));
    try {
      return realpath(resolved);
    } catch {
      return resolved; // not on disk (yet) — compare as-is
    }
  }

  function addAllowedMediaDir(dir) {
    if (dir) allowedMediaDirs.add(canonicalize(dir));
  }

  function addBaselineMediaDir(dir) {
    if (!dir) return;
    baselineMediaDirs.push(path.resolve(String(dir)));
    addAllowedMediaDir(dir);
  }

  function resetMediaAllowlist() {
    allowedMediaDirs.clear();
    mediaRootsLoaded = null;
    for (const dir of baselineMediaDirs) addAllowedMediaDir(dir);
  }

  function ensureMediaRootsLoaded() {
    if (!mediaRootsLoaded) {
      mediaRootsLoaded = (async () => {
        if (!getCatalogPath() || !catalogHasDb()) return;
        try {
          const roots = await loadCatalogRoots();
          for (const root of roots) {
            if (!root?.path) continue;
            addAllowedMediaDir(root.path);
            // Roots are often registered per-file (the user imports individual
            // images from anywhere), which would only allow that exact file and
            // block sibling derivatives written next to it — AI repaint outputs,
            // editor saves, crops. Allow the containing directory too so anything
            // in a folder the user imported from can be served.
            try {
              if (!isDirectory(root.path)) addAllowedMediaDir(path.dirname(root.path));
            } catch { /* path vanished from disk — skip */ }
          }
        } catch (err) {
          console.warn("[media] failed to load catalog roots for allowlist:", err.message);
          mediaRootsLoaded = null; // retry on next request
        }
      })();
    }
    return mediaRootsLoaded;
  }

  function isAllowedMediaPath(requestedPath) {
    const resolved = canonicalize(requestedPath);
    const catalogPath = getCatalogPath();
    if (catalogPath) {
      const catalogCanonical = canonicalize(catalogPath);
      if (resolved === catalogCanonical || resolved.startsWith(catalogCanonical + path.sep)) return true;
    }
    for (const dir of allowedMediaDirs) {
      if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
    }
    return false;
  }

  // The check every server does: allowed, or allowed once the catalog's roots
  // are loaded (they load lazily — the first original-file view after startup).
  async function isAllowedMediaPathLoaded(requestedPath) {
    if (isAllowedMediaPath(requestedPath)) return true;
    await ensureMediaRootsLoaded();
    return isAllowedMediaPath(requestedPath);
  }

  return {
    canonicalize,
    addAllowedMediaDir,
    addBaselineMediaDir,
    resetMediaAllowlist,
    ensureMediaRootsLoaded,
    isAllowedMediaPath,
    isAllowedMediaPathLoaded,
  };
}

module.exports = { createMediaAllowlist };
