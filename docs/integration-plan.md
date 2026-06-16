# Integration with Photo-Editing Software — Implementation Plan

Goal: make AfterFrame integrate cleanly into a photographer's editing workflow
(Lightroom / Photoshop / 像素蛋糕 / etc.).

## Through-line: the round-trip editing loop

Right-click → open the original in PS / 像素蛋糕 → edit & export to a watched
directory → AfterFrame auto-reimports the result. So #3 and #1 are not isolated;
together they form the core value. Build order is chosen to ship value early
while moving toward this loop.

## Current state (as of v0.3.1)

| Capability | Status |
|---|---|
| **Watch dir → auto-import** | ❌ None for the catalog. `ImageWatcher` exists in the sidecar but it is a *polling RAW-matcher*, not a generic auto-importer, and is **not wired into the desktop app**. Only `open-file` (macOS "Open with AfterFrame") exists as a manual entry. |
| **Batch export** | ⚠️ Backend ready: sidecar `export-assets` (dest / max-edge / format / quality) + MCP `export_assets`. **Not exposed in the UI** — only agents can use it. |
| **Open in external editor** | ❌ None. Gallery `ContextMenu` (Gallery.jsx) has edit/compare/collage/annotate/reveal/copy/delete/add-to-folder and **supports submenus**, so "Open with →" slots in cleanly. |
| Smart collections | `kind` / `rules_json` columns exist but rule logic is **not implemented** (placeholder). |

## Shared groundwork (all three)

- **Settings storage**: reuse `readAppSettings` / `updateAppSettings` (already used
  for previews / aiPreferences). Add `settings.integrations = { watchedDirs: [], externalEditors: [] }`.
- **New Settings tab `Integrations`** in SettingsOverlay (TABS array), holding the
  watched-dirs and external-editors sections.

---

## #3 — Right-click "Open with" (do first; lowest cost)

**Sidecar**: no change.

**Main process** (electron/main.js or a new ipc module)
- `app:detect-editors` → scan `/Applications` (+ `~/Applications`) against a
  built-in list (Photoshop, 像素蛋糕, Affinity Photo, GIMP, Pixelmator…), return
  `[{ label, appPath }]`.
- `app:open-in-editor` `(filePaths[], appPath)` → `execFile("open", ["-a", appPath, ...filePaths])`. Multi-select supported.
- Merge built-in detected list + user-defined editors from settings.

**preload / api**: `detectEditors()`, `openInEditor(paths, appPath)`.

**Renderer**
- Settings → Integrations: external-editor list (detected + "Add custom app…",
  persisted to `externalEditors`).
- Gallery `ContextMenu`: add "Open with →" submenu (reuse existing `MenuItem`
  children pattern), list editors, click → `openInEditor(selected originals, appPath)`.

**Edge cases**: app missing → toast; multi-select → pass all files at once.
**Effort**: low (~half day). App source decision: auto-detect + user-custom.

---

## #2 — Batch export UI (medium; backend ready)

**Sidecar**: `export-assets` already exists. Only add: wrap as a **job** with
progress for large batches; small batches call synchronously.

**Main process**: `workspace:export-assets` `({ assetIds, dest, maxEdge, format, quality })`
→ dest chosen via existing `pickDirectories` → call sidecar export-assets →
return result / job. Add dest dir to media allowlist (`addAllowedMediaDir`).

**preload / api**: `exportAssets(opts)`.

**Renderer**
- Gallery `ContextMenu`: add "Export…", opening a small panel for
  **dest dir + max-edge + format + quality** (remember last as default).
- Progress in existing JobDock; completion toast "Reveal in Finder".

**Cloud / phone**: target dir = the user's iCloud Drive / Dropbox / 阿里云盘 sync
folder; the app doesn't handle upload itself. Covers ~80% of the use case.
**(Later) Smart export**: depends on implementing smart-collection rules — out of
scope for this milestone.
**Effort**: low-medium (~1 day).

---

## #1 — Watched directories → auto-import (heaviest; most value)

**Main process** (core; use `chokidar`, new dependency)
- Watch `settings.integrations.watchedDirs`. Key config:
  - `ignoreInitial: true` (don't treat existing files as new events)
  - `awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 }`
    — **handles Lightroom's write-temp-then-rename** so we never import a partial file
  - only image/video extensions (reuse `DEFAULT_IMAGE_EXTENSIONS` + video exts)
- On stable new file → enqueue (debounced batch) → `registerRoots` that dir + run
  the existing import job (`processed_only`) → reuse "already-in-catalog" dedup +
  optional "auto-annotate on import".
- Lifecycle: start watchers from settings on launch; `add`/`unwatch` on edit;
  reset on catalog switch.

**preload / api**: `getWatchedDirs()`, `addWatchedDir()` (via `pickDirectories`),
`removeWatchedDir(path)`. Changes notify main to reload watchers.

**Renderer**: Settings → Integrations: watched-dir list + add/remove + an
"auto-annotate on watch import" toggle. New file imported → toast + gallery
refresh (reuse existing `onCatalogChanged` / import-job-complete refresh chain).

**Edge cases**
- Same file written repeatedly (editor re-saves) → awaitWriteFinish + dedup.
- Large drop (Lightroom exports 200 at once) → batch enqueue, single import job.
- Watched dir deleted / unreachable → skip gracefully + status hint.
- Avoid loops if the app's own export dest is also a watched dir → dedup safety net.

**Effort**: medium-high (~2–3 days: chokidar wiring, debounced batching,
lifecycle, settings UI, job-chain integration).

---

## Milestones

1. **M1 — #3 Open with** (independently shippable)
2. **M2 — #2 Batch export** (independently shippable)
3. **M3 — #1 Watched directories** (closes the round-trip loop)

Each milestone ships with e2e coverage (context-menu item renders / export job /
mock watched-dir import).

## Deferred

- Smart-folder auto-export (needs smart-collection rules implemented first).
- `author` field in apps/desktop/package.json (electron-builder warning).
- Lightbox: load HD/preview first, lazy-swap to original on zoom (kills the
  day-to-day GPU tile-memory warnings from 50MB+ originals).
