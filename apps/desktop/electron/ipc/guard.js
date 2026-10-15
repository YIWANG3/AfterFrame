// The "is a catalog open" guard every ipc module and the MCP server put in
// front of a sidecar call, written once. Until review 2026-10-14 §A it was
// 48 inline copies of `if (!currentCatalogPath || !catalogHasDb()) return X`.
//
//   withCatalog(getCatalogState, fallback, fn)
//     fn runs when a catalog with a database is open; otherwise the handler
//     answers with `fallback` — a value, or a function that returns one (or
//     throws, see catalogRequired). Wraps handlers and plain async functions
//     alike: it passes every argument through untouched.
//   catalogRequired(message)
//     a fallback that rejects, for handlers whose caller must hear why.
//   requireCatalogPath(getCatalogState)
//     the MCP form: the open catalog's path, or an error naming which half
//     is missing (no catalog / no database yet).
//   jobStatusHandler(deps, jobType)
//     the `*-status` IPC handler: the latest job of that type formatted for
//     the renderer, an empty status without a catalog or when the sidecar
//     fails (a status poll must never reject).
//   sidecarQueries(ipcMain, deps, table)
//     registers read-only `[channel, verb, fallback, toArgs?]` rows: guard,
//     call commands[verb], and answer `fallback` on a sidecar error (logged)
//     — the shape every browse-side read shares.

function catalogOpen(getCatalogState) {
  const { currentCatalogPath, catalogHasDb } = getCatalogState();
  return !!currentCatalogPath && catalogHasDb();
}

function withCatalog(getCatalogState, fallback, fn) {
  return async (...args) => {
    if (!catalogOpen(getCatalogState)) return typeof fallback === "function" ? fallback() : fallback;
    return fn(...args);
  };
}

function catalogRequired(message = "Open a catalog first.") {
  return () => {
    throw new Error(message);
  };
}

function requireCatalogPath(getCatalogState) {
  const { currentCatalogPath, catalogHasDb } = getCatalogState();
  if (!currentCatalogPath) throw new Error("No catalog is open in AfterFrame.");
  if (!catalogHasDb()) throw new Error(`Catalog at ${currentCatalogPath} is empty (no database yet). Import something first.`);
  return currentCatalogPath;
}

function jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, jobType) {
  return withCatalog(getCatalogState, () => formatJobStatus(null), async () => {
    try {
      return await latestJobStatus(jobType);
    } catch {
      return formatJobStatus(null);
    }
  });
}

// toArgs(...handlerArgs) → the verb's argument list, or null for "nothing to
// ask" (answered with the fallback). Default: the first argument as an
// options object.
const optionsArg = (options) => [options || {}];

function sidecarQueries(ipcMain, { commands, getCatalogState }, table) {
  for (const [channel, verb, fallback, toArgs = optionsArg] of table) {
    ipcMain.handle(channel, withCatalog(getCatalogState, fallback, async (_event, ...args) => {
      const verbArgs = toArgs(...args);
      if (!verbArgs) return fallback;
      try {
        return (await commands[verb](...verbArgs)) ?? fallback;
      } catch (err) {
        console.warn(`[${channel}] sidecar error:`, err.message);
        return fallback;
      }
    }));
  }
}

module.exports = { withCatalog, catalogRequired, requireCatalogPath, jobStatusHandler, sidecarQueries };
