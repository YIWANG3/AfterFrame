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

- New Settings **"Integrations"** tab (SettingsOverlay TABS) hosting both lists.
- `settings.integrations = { externalEditors: [], watchedDirs: [] }`
  (reuse `readAppSettings` / `updateAppSettings`).

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

**Behavior**
- Settings → Integrations: list of watched directories (add via `pickDirectories`,
  remove). Persisted in `settings.integrations.watchedDirs`.
- Main process watches them (chokidar; new dependency):
  - `ignoreInitial: true` (don't re-import existing files on startup)
  - `awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 }`
    — handles editors that write-temp-then-rename on export (no partial imports)
  - only image / video / RAW extensions (reuse the known extension sets)
- New stable file → enqueue (debounced batch) → run the existing import job
  (`processed_only`) → reuse "already-in-catalog" dedup + optional
  "auto-annotate on import".
- Lifecycle: start watchers from settings on launch; add/unwatch on edit; reset
  on catalog switch.
- New imports → toast + gallery refresh (existing import-complete chain).

**Edge cases**
- Editor re-saves the same file repeatedly → awaitWriteFinish + dedup.
- Large export drop (e.g. Lightroom exports 200) → batch enqueue, one import job.
- Watched dir deleted / unreachable → skip gracefully + status hint.

**Effort**: medium-high (~2–3 days: chokidar wiring, debounce, lifecycle,
settings UI, job-chain integration).

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
