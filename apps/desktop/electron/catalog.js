// Where the open catalog lives, and the path rules around it.
//
// This owns the ONE mutable "current catalog" value. Everything that needs it
// — the sidecar transport, the watcher, the media:// allowlist, every ipc
// module and the MCP server — reads it through path() / state() at call time,
// so a switch is visible everywhere at once. Switching itself stays in main.js
// (switchCatalogTo): it orchestrates services main owns (resident sidecar,
// media allowlist, MCP cache, watcher, people-job recovery), and pulling those
// in here would just move the coupling. Extracted from main.js (review
// 2026-09-16 §2) so the path logic can be unit-tested.

const path = require("node:path");
const fs = require("node:fs");

function dirHasCatalogDb(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((e) => e.endsWith(".sqlite3") || e === "catalog.db");
  } catch {
    return false;
  }
}

// User-facing paths may be typed, dropped or picked without the extension, and
// pre-rename catalogs used .mwcatalog. Relative paths resolve against the repo
// root (dev convenience: MEDIA_WORKSPACE_CATALOG=data/foo).
function normalizeCatalogPath(rootDir, targetPath) {
  if (!targetPath) {
    return null;
  }
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(rootDir, targetPath);
  if (resolved.endsWith(".afcatalog")) return resolved;
  if (resolved.endsWith(".mwcatalog")) return resolved.replace(/\.mwcatalog$/, ".afcatalog");
  return `${resolved}.afcatalog`;
}

// Startup precedence: explicit "no default" (welcome-screen testing) >
// MEDIA_WORKSPACE_CATALOG > the last catalog the user had open (if it still
// exists) > the dev scratch catalog (packaged builds have no default).
function resolveInitialCatalogPath({ env, configuredCatalogPath, rootDir, readAppSettings, scratchCatalogPath }) {
  // Simulate packaged first-run (no default catalog) in dev / e2e, where a
  // scratch catalog would otherwise always be present. Lets you exercise the
  // WelcomeOverlay locally: AFTERFRAME_NO_DEFAULT_CATALOG=1 npm run dev
  if (env.AFTERFRAME_NO_DEFAULT_CATALOG) return null;
  if (configuredCatalogPath) {
    return path.isAbsolute(configuredCatalogPath)
      ? configuredCatalogPath
      : path.resolve(rootDir, configuredCatalogPath);
  }
  // Restore last opened catalog (works in both dev and packaged mode)
  const settings = readAppSettings();
  const last = settings.lastCatalogPath;
  if (last && fs.existsSync(last)) return last;
  // Fallback: dev mode uses scratch catalog, packaged mode has no default
  return scratchCatalogPath;
}

function createCatalogState({
  rootDir,
  sidecarSrc,
  isPackaged,
  configuredCatalogPath,
  env = process.env,
  getUserDataDir,
  readAppSettings,
}) {
  // In dev mode, default catalog paths live in the monorepo data/ dir. In
  // packaged mode there is no default — the user must create or open one.
  const scratchCatalogPath = isPackaged ? null : path.join(rootDir, "data", "ui-import-scratch.afcatalog");
  const reviewCatalogPath = isPackaged ? null : path.join(rootDir, "data", "review-2026.afcatalog");

  let current = resolveInitialCatalogPath({ env, configuredCatalogPath, rootDir, readAppSettings, scratchCatalogPath });

  // The bundled demo library lives under userData — app-owned, apart from
  // real catalogs (see openSampleCatalog in main.js).
  const samplePath = () => path.join(getUserDataDir(), "afterframe", "sample.afcatalog");
  const isSample = () => !!current && current === samplePath();

  function hasDb() {
    if (!current) return false;
    try {
      const entries = fs.readdirSync(current);
      const has = entries.some((e) => e.endsWith(".sqlite3") || e === "catalog.db");
      console.log("[catalogHasDb]", current, "entries:", entries.length, "hasDb:", has);
      return has;
    } catch (err) {
      console.warn("[catalogHasDb] error reading dir:", err.message);
      return false;
    }
  }

  return {
    scratchCatalogPath,
    reviewCatalogPath,
    path: () => current,
    set(next) {
      current = next || null;
      return current;
    },
    hasDb,
    hasDbAt: dirHasCatalogDb,
    normalize: (targetPath) => normalizeCatalogPath(rootDir, targetPath),
    createAt(targetPath) {
      const normalizedPath = normalizeCatalogPath(rootDir, targetPath);
      if (!normalizedPath) {
        return null;
      }
      fs.mkdirSync(normalizedPath, { recursive: true });
      return normalizedPath;
    },
    samplePath,
    isSample,
    // The shape every ipc/mcp module receives as getCatalogState(). Fresh
    // object per call; catalogHasDb is a function so it reads the current
    // path when invoked, not when the deps were wired.
    state: () => ({ currentCatalogPath: current, catalogHasDb: hasDb }),
    // workspace:info payload for the renderer.
    info: () => ({
      rootDir,
      catalogPath: current,
      scratchCatalogPath,
      reviewCatalogPath,
      sidecarSrc,
      isSampleCatalog: isSample(),
    }),
  };
}

module.exports = { createCatalogState, normalizeCatalogPath, resolveInitialCatalogPath, dirHasCatalogDb };
