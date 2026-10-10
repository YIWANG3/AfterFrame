# Settings scope

Settings must make it clear when a value follows the current Catalog. Global
app settings are the default and do not need a repeated label:

- **Current Catalog** — travels with the `.afcatalog` and changes immediately
  when the user switches catalogs.
- Unlabeled settings are global to this app on the current Mac.

## Current ownership

| Area | Setting or data | Scope | Storage |
| --- | --- | --- | --- |
| Library | Watched directories | Current Catalog | `.afcatalog/settings.json` |
| Library | Assets, roots, tags, collections, annotations, jobs | Current Catalog | `.afcatalog/catalog.sqlite3` |
| People | Face embeddings, groups, index progress/model version | Current Catalog | `.afcatalog/catalog.sqlite3` |
| General | Language | Global | app `settings.json` |
| General | Theme and panel widths | Global | renderer `localStorage` |
| Keyboard Shortcuts | Rebound keys (overrides of `shared/shortcuts.mjs`'s defaults; the native menu's accelerators follow) | Global | `shortcuts` in app `settings.json` (web: `afterframe.shortcuts` in `localStorage`); in `.afsettings` under General |
| AI Annotation | Provider list, active provider, behavior | Global | app `settings.json` |
| AI Annotation | Provider credentials | Global | encrypted app `settings.json` |
| AI Repaint | Providers, models, credentials | Global | app `settings.json` |
| People | Installed models, active model, update preference | Global | app support + app `settings.json` |
| Library | Generate HD previews on future imports | Global | app `settings.json` |
| Library | Depth, sticker, and video-proxy caches | Global | app support directories |
| Library | LUT library (imported .cube copies) and the LUT folders read in place | Global | `afterframe/luts/` in app support, `lutFolders` in app `settings.json`, header cache and Log marks in `afterframe/luts-index.json` |
| Integrations | Detected external editors | Global | detected at runtime |

## Remembered choices

A tool opens on what it was last set to rather than on its built-in default.
These are conveniences, global to this Mac, kept in renderer `localStorage`
under `afterframe.pref.*` (`src/utils/prefs.js`, `src/hooks/usePref.js`):

- No IPC: nothing to add to `shared/ipcChannels.mjs` or the web bridge.
- Every read is checked. A value the check rejects falls back to the
  default: an old version's value, an out-of-range number, a font that is no
  longer installed, a folder that is gone (`statDirs`).
- Nothing is written until the user changes the control, and a reset clears
  the key, so a later version can still change a default.
- Not part of a settings export (`.afsettings`).

| Area | Remembered | Starts fresh |
| --- | --- | --- |
| Text | The look of the text last styled (font, size, weight, fill, stroke, background, shadow, glow, spacing, case, alignment, opacity), for the next "+ Text". A preset still gives a preset's look. | Text, position, rotation, depth; frame text |
| Collage | Canvas ratio, gap, padding, corner radius, background (with a "Defaults" reset), export width, export folder, batch group size, order, remainder, file-name prefix, the layout last picked for each image count | Images, single/batch mode, per-page layouts, pan/zoom |
| Split | Panel ratio (or custom W:H), output folder (with "Back to the original's folder"), subfolder toggle | Panel count, region |
| LUT | Strength for a LUT chosen on a photo that has none | Which LUT (never applied unasked) |
| AI Repaint | Style, temperature, aspect ratio, resolution, compact style list | Prompt typed for one photo |
| Handwriting | Style, fill, provider, model per provider | Text, reference image, a hand-edited prompt |
| Sticker | Cut-out outline width and colour | |
| Gallery | Display mode, thumbnail size, library sort (not a folder-only sort) | View, search, filters |
| Compare | Side by side or top/bottom | |
| Settings | Last tab | |

Deliberately not remembered: the crop ratio (a remembered ratio would crop the
next photo unasked), the frame template and the LUT itself (both would change
every photo as it opens), filters and search (a view that silently shows
fewer photos reads as lost photos).

## Follow-up decisions

The following are global today, but are good candidates for Catalog scope:

1. **Annotation behavior** — `autoOnImport`, languages, limits, video sampling,
   and custom instructions can reasonably differ between a portraits catalog
   and a product catalog. Provider endpoints and credentials should remain
   global.
2. **HD preview generation** — different catalogs can have different offline or
   disk-space requirements. The default can remain global while a Catalog
   override is added later.
3. **Active face model** — installed model files should remain global, but a
   Catalog may eventually pin the model used for its embedding space. The
   catalog database already records model identity for index jobs.
4. **Sticker library** — the README describes it as per-catalog, while the
   desktop implementation currently stores it under the global app-support
   directory. Decide whether stickers are reusable across catalogs, then align
   the product copy and storage.

## Watched-directory invariants

- A new Catalog starts with no watched directories.
- Switching catalogs closes the old watcher, clears its debounce queue, and
  starts only the new Catalog's directories.
- A queued event includes the Catalog identity that produced it and is dropped
  if the current Catalog changed before delivery.
- Adding or removing a directory writes to the Catalog captured when the action
  began, so an in-flight settings write cannot land in a newly opened Catalog.
