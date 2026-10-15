// Read-only catalog queries — gallery browse + asset detail lookups.
// All wrap the Python sidecar; return empty results when no catalog loaded.

const { withCatalog, catalogRequired, sidecarQueries } = require("./guard");

// Files per thumbnail pass: keeps a pass's command line short, and a long
// queue of missing thumbnails made in steps.
const ENSURE_CHUNK = 200;

const EMPTY_SUMMARY = { total_images: 0, total_raws: 0, matched: 0, unmatched: 0, pending: 0 };
const noArgs = () => [];
const idArg = (assetId) => (assetId ? [assetId] : null);

// The reads that share one shape: guard, ask the sidecar, and answer with an
// empty result (logged) when it fails — the gallery must keep drawing.
// ipcChannels.test.js reads this table (and PEOPLE_WRITES), as these
// channels have no handle(...) literal of their own.
//   [channel, commands verb, fallback, toArgs?]  (guard.sidecarQueries)
const SIDECAR_QUERIES = [
  ["workspace:summary", "summary", EMPTY_SUMMARY, noArgs],
  ["workspace:roots", "catalogRoots", [], noArgs],
  ["workspace:browse-map-points", "browseMapPoints", []],
  ["workspace:discover-collections", "discoverCollections", { places: [], memories: [] }, noArgs],
  ["workspace:get-asset-location", "getAssetLocation", null, idArg],
  ["workspace:resolve-ai-locations", "resolveAiLocations", null, noArgs],
  ["workspace:facet-values", "facetValues", null],
  ["workspace:camera-makes", "cameraMakes", [], noArgs],
  ["workspace:search-facet", "searchFacet", [], (options) => (options?.field ? [options] : null)],
  ["workspace:list-people-groups", "listPeopleGroups", []],
  ["workspace:similar-people-groups", "similarPeopleGroups", []],
  ["workspace:people-group-detail", "peopleGroupDetail", null],
];

// People corrections write membership audit rows in the sidecar; errors are
// surfaced to the renderer so the user sees why a rename/merge didn't land.
const PEOPLE_WRITES = [
  ["workspace:rename-people-group", "renamePeopleGroup"],
  ["workspace:set-people-group-cover", "setPeopleGroupCover"],
  ["workspace:set-people-group-state", "setPeopleGroupState"],
  ["workspace:set-people-groups-state", "setPeopleGroupsState"],
  ["workspace:merge-people-groups", "mergePeopleGroups"],
  ["workspace:remove-face-from-person", "removeFaceFromPerson"],
  ["workspace:assign-face-to-person", "assignFaceToPerson"],
];

const uniquePaths = (paths) => [...new Set((paths || []).map(String).filter(Boolean))];

function register({ ipcMain, commands, getCatalogState }) {
  const guarded = (fallback, fn) => withCatalog(getCatalogState, fallback, fn);

  sidecarQueries(ipcMain, { commands, getCatalogState }, SIDECAR_QUERIES);
  for (const [channel, verb] of PEOPLE_WRITES) {
    ipcMain.handle(channel, guarded(catalogRequired(), (_event, options) => commands[verb](options || {})));
  }

  ipcMain.handle("workspace:locate-image-asset", guarded({ index: null }, (_event, options) => commands.locateImageAsset(options)));
  ipcMain.handle("workspace:browse", guarded([], (_event, options) => commands.browseImages(options)));
  ipcMain.handle("workspace:detail", (_event, imagePath) => commands.assetDetail({ imagePath }));
  ipcMain.handle("workspace:detail-by-id", (_event, assetId) => commands.assetDetail({ assetId }));

  // On-demand HD previews for specific source paths (collage cells). Skips files
  // that already have an HD preview, so it's cheap to call on every open.
  ipcMain.handle("workspace:ensure-hd-previews", guarded({ generated: 0, skipped: 0 }, async (_event, paths) => {
    const list = uniquePaths(paths);
    if (!list.length) return { generated: 0, skipped: 0 };
    try {
      return await commands.ensureHdPreviews(list);
    } catch (err) {
      console.warn("[workspace:ensure-hd-previews] sidecar error:", err.message);
      return { error: String(err.message) };
    }
  }));

  // Thumbnails missing from the gallery: an import cancelled before its
  // thumbnail pass, a file whose thumbnail failed. Made where missing, in a
  // background process, one pass at a time (two would only read the same disk
  // against each other) and at most ENSURE_CHUNK files a process.
  let ensuring = Promise.resolve();
  const emptyTotal = () => ({ generated: 0, skipped: 0, failed: 0, deferred: 0 });
  ipcMain.handle("workspace:ensure-previews", guarded(emptyTotal, async (_event, paths) => {
    const total = emptyTotal();
    const list = uniquePaths(paths);
    for (let start = 0; start < list.length; start += ENSURE_CHUNK) {
      const chunk = list.slice(start, start + ENSURE_CHUNK);
      const pass = ensuring.then(() => commands.ensurePreviews(chunk));
      ensuring = pass.catch(() => {});
      try {
        const result = await pass;
        for (const key of Object.keys(total)) total[key] += Number(result?.[key] || 0);
      } catch (err) {
        console.warn("[workspace:ensure-previews] sidecar error:", err.message);
        return { ...total, error: String(err.message) };
      }
    }
    return total;
  }));

  ipcMain.handle("workspace:refresh-assets", guarded(catalogRequired(), async (_event, paths) => {
    const list = uniquePaths(paths);
    if (!list.length) return { requested: 0, refreshed: 0, deferred: 0, failed: 0 };
    try {
      return await commands.refreshAssets(list);
    } catch (err) {
      console.warn("[workspace:refresh-assets] sidecar error:", err.message);
      throw err;
    }
  }));
}

module.exports = { register, SIDECAR_QUERIES, PEOPLE_WRITES };
