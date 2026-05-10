// Background job IPC — import / enrichment / preview pipelines.
// Each pair: a *-status query that returns the latest job snapshot,
// and a *-start handler that kicks off a new run via the sidecar.

function register({
  ipcMain,
  getCatalogState,
  formatJobStatus,
  latestJobStatus,
  startImportTask,
  startEnrichmentTask,
  startPreviewTask,
}) {
  function emptyStatus() {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    return (!currentCatalogPath || !catalogHasDb()) ? formatJobStatus(null) : null;
  }

  ipcMain.handle("workspace:import-status", async () => {
    const empty = emptyStatus();
    if (empty) return empty;
    try { return await latestJobStatus("import"); } catch { return formatJobStatus(null); }
  });
  ipcMain.handle("workspace:import-start", (_event, options) => startImportTask(options));

  ipcMain.handle("workspace:enrichment-status", async () => {
    const empty = emptyStatus();
    if (empty) return empty;
    try { return await latestJobStatus("enrichment"); } catch { return formatJobStatus(null); }
  });
  ipcMain.handle("workspace:enrich-start", () => startEnrichmentTask());

  ipcMain.handle("workspace:preview-status", async () => {
    const empty = emptyStatus();
    if (empty) return empty;
    try { return await latestJobStatus("preview"); } catch { return formatJobStatus(null); }
  });
  ipcMain.handle("workspace:preview-start", (_event, kind) => startPreviewTask(kind || "preview"));
}

module.exports = { register };
