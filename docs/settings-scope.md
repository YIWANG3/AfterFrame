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
| AI Annotation | Provider list, active provider, behavior | Global | app `settings.json` |
| AI Annotation | Provider credentials | Global | encrypted app `settings.json` |
| AI Repaint | Providers, models, credentials | Global | app `settings.json` |
| People | Installed models, active model, update preference | Global | app support + app `settings.json` |
| Library | Generate HD previews on future imports | Global | app `settings.json` |
| Library | Depth, sticker, and video-proxy caches | Global | app support directories |
| Integrations | Detected external editors | Global | detected at runtime |

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
