# Integration with Photo-Editing Software — Plan

Goal: fit AfterFrame into a photographer's editing workflow (Photoshop /
Lightroom / 像素蛋糕 / etc.).

## Design decision: TWO independent features, no managed round-trip

These are two separate, independent features. **Every imported asset is treated
the same — any format (JPG / PNG / TIFF / HEIC / RAW / …) can be opened in an
external editor.** This is NOT RAW-specific.

AfterFrame does **not** create edit-copies, does **not** orchestrate a
Lightroom-style "Edit in…" / copy-prep loop, and does **not** force version
stacking. Keep it simple and user-controlled:

1. **Open in external editor** — right-click, open the original file(s) in the
   user's chosen app. That's it. Works for any imported asset, regardless of format.
2. **Watched directories** — user designates folders; anything that lands there
   auto-imports into the catalog.

The two combine naturally: open a photo in PS, edit, save/export into a watched
directory → it auto-imports. No copy-prep, no managed stacking — the user decides
where the result goes.

**Emergent round-trip (no code for it):** if the user points their editor's
export target at a watched directory, edits flow back automatically as new
browseable assets. We don't manage the copy or the stacking — the user controls
it by choosing where they export. Existing import logic still applies (e.g.
name-based RAW↔JPEG grouping for the "Add RAW source" flow).

A third, unrelated feature — **batch export to a directory** (push photos to a
cloud-sync / phone folder) — is deferred and tracked separately at the bottom.

## Shared groundwork

- Settings **"Integrations"** hosts globally detected editors. Catalog-specific
  watched directories live under **"Library"**.
- `.afcatalog/settings.json` owns
  `integrations = { watchedDirs: [] }` through the catalog settings helpers.

---

## Feature A — Open in external editor (right-click, multi-select)

**Behavior**
- Gallery context menu gains an **"Open with →"** submenu (reuses the existing
  `MenuItem` children pattern in Gallery.jsx).
- **Multi-select**: opens every selected asset's file at once.
- Available for **every imported asset, any format** (JPG/PNG/TIFF/HEIC/RAW/…).
- Opens the **original** file(s) — `image_path` / canonical path, as-is. (External
  apps decode their own formats incl. RAW; an app that can't read a given format
  surfaces its own error — not our concern.)
- Assets with `exists_on_disk === false` are skipped/disabled.

**Editor list**
- Auto-detect a built-in list under `/Applications` (+ `~/Applications`):
  Photoshop, 像素蛋糕, Affinity Photo, Pixelmator Pro, GIMP, …
- User can add custom apps in Settings → Integrations (label + app path).
- Submenu = detected ∪ user-defined.

**Wiring**
- Main: `app:detect-editors` (scan) and `app:open-in-editor(filePaths[], appPath)`
  → `execFile("open", ["-a", appPath, ...filePaths])`.
- preload/api: `detectEditors()`, `openInEditor(paths, appPath)`.
- Settings → Integrations: external-editor list UI.

**Effort**: low (~half day).

---

## Feature B — Watched directories (auto-import)

**Watched ≠ import source.** This is a small, explicit, opt-in set of "live"
folders (default empty) — NOT every directory the user has ever imported from.
Typical use: 1–2 folders (an editor's export target, a download/incoming folder).
Per-catalog (`<name>.afcatalog/settings.json`) — a watched export folder belongs
to the catalog that configured it. Switching catalogs stops the old watcher,
discards queued events from it, and starts only the new catalog's watcher.

**How the list is populated**
- **Settings → Library**: manual add/remove, visibly labeled “Current Catalog”.
  Persisted in the catalog's `settings.integrations.watchedDirs`.
- **Contextual prompt**: when the user imports by selecting a **folder** (folder
  picker or drag-dropped folder), after import show a bottom-right toast
  *"Add ‹folder› to watched directories?"* with a one-click **Add** action.
  Only when the folder isn't already watched. (Needs main-process `app:stat-dirs`
  so the renderer knows which selected paths are directories.)

**Watcher (main process, chokidar — new dep)**
- `chokidar.watch(dirs, { ignoreInitial: true, depth: 10,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 } })`
- Listen to **`add`** only; filter to image/video/RAW extensions; skip dotfiles
  and editor temp files (awaitWriteFinish covers write-then-rename).
- **Debounce-batch**: collect new file paths into a pending Set, flush after
  ~1s idle → one batch (a 200-file export = one import, not 200).
- On flush, **send `workspace:watched-import` IPC to the renderer with the new
  file paths** — the renderer runs its existing `addImagesFromPaths(paths)` flow
  (registerRoots + import job + dedup + refresh + requireCatalog guard). We send
  the specific new files (not the whole dir) so we don't re-scan large trees.
  Mirrors the existing `onExternalImport` (open-file) bridge.

**Startup catch-up (FSEvents only fires while running)**
- A live watcher misses anything added while the app was closed, and
  `ignoreInitial` means a restart won't re-emit it. So pair the live watcher with
  a **catch-up scan**: on launch (and when a dir is newly added), run a normal
  import over each watched dir. Catalog **dedup makes it idempotent** — already-
  imported files are skipped; only what landed while closed (or a freshly-added
  dir's existing contents) is imported.
- Two mechanisms, one import path:
  - running → FSEvents live watcher (new files only, no full scan);
  - launch / dir-added → catch-up scan (dir scan + dedup).
- Future optimization: store a last-scan timestamp and only consider
  mtime-newer files in catch-up, to avoid full re-scans of large dirs.

**Lifecycle**
- Start the current Catalog's watcher after the window is ready; rebuild it on
  every Catalog switch. The renderer runs catch-up for the opened Catalog.
- Add/remove dir → update settings + `watcher.add/unwatch` (+ catch-up the new
  dir), no full restart.
- No catalog open (welcome state) → no watcher and no watched-directory list.

**Edge cases**
- Editor re-saves same file → awaitWriteFinish + catalog dedup.
- Large export drop → debounce-batch → single import.
- Watched dir deleted / unreachable → chokidar error handled, skipped.
- Recursion capped at depth 10 (avoid watching pathologically deep trees).

**Effort**: medium-high (~2–3 days: chokidar wiring, debounce, lifecycle,
settings UI, contextual toast, job-chain integration).

---

## Suggested order

1. **Feature A** (low cost, immediately useful) — ship "Open with".
2. **Feature B** (the heavier one) — watched directories.

Each ships with e2e (context-menu item renders / opens; mock watched-dir import).

## Deferred / separate

- **Batch export to a directory** — push selected assets to a chosen folder
  (e.g. iCloud Drive / Dropbox / 阿里云盘 sync dir) for cloud/phone. Backend
  (`export-assets`) already exists; only needs a UI. Independent of the above.
- `package.json` `author` — done.
- Lightbox: load HD/preview first, lazy-swap to original on zoom (GPU
  tile-memory warnings from 50MB+ originals).
- Facet camera/lens for RAW — done (browseable assets now included).
