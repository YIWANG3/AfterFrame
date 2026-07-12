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
  commands,
  resumePeopleIndexJob,
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

  // ── Unified job handling ───────────────────────────────────────────────────
  // All queued/running jobs across every type, formatted for the renderer.
  ipcMain.handle("workspace:active-jobs", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
    try {
      const jobs = await commands.listActiveJobs();
      return jobs.map((job) => ({
        ...formatJobStatus(job),
        jobType: job.job_type,
        cancel_requested: !!job.cancel_requested,
      }));
    } catch {
      return [];
    }
  });

  // Cooperative cancel: flags the job; the runner notices at its next
  // progress checkpoint and exits with status='cancelled'.
  ipcMain.handle("workspace:cancel-job", async (_event, jobId) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return null;
    if (!jobId) return null;
    return await commands.cancelJob(jobId);
  });

  // People indexing is intentionally cooperative: it checkpoints only after a
  // complete asset so pausing never commits a partial face set. The generic
  // handlers keep the Activity Center future-proof for other resumable jobs.
  ipcMain.handle("workspace:pause-job", async (_event, jobId) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb() || !jobId) return null;
    return await commands.pauseJob(jobId);
  });

  ipcMain.handle("workspace:resume-job", async (_event, jobId) => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb() || !jobId) return null;
    const job = await commands.getJob(jobId);
    if (job?.job_type === "people_index" && resumePeopleIndexJob) {
      const resumed = await resumePeopleIndexJob(jobId);
      if (resumed != null) return resumed;
    }
    return await commands.resumeJob(jobId);
  });
}

module.exports = { register };
