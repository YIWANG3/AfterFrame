// Background job IPC — import / enrichment / preview pipelines.
// Each pair: a *-status query that returns the latest job snapshot,
// and a *-start handler that kicks off a new run via the sidecar.

const { withCatalog, jobStatusHandler } = require("./guard");

function register({
  ipcMain,
  getCatalogState,
  formatJobStatus,
  latestJobStatus,
  startImportTask,
  startEnrichmentTask,
  startPreviewTask,
  startColorsTask,
  startVisualTask,
  startOrientationTask,
  listActiveJobsFormatted,
  resumeJob,
  commands,
}) {
  const guarded = (fallback, fn) => withCatalog(getCatalogState, fallback, fn);
  const status = (jobType) => jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, jobType);

  ipcMain.handle("workspace:import-status", status("import"));
  ipcMain.handle("workspace:import-start", (_event, options) => startImportTask(options));

  ipcMain.handle("workspace:enrichment-status", status("enrichment"));
  ipcMain.handle("workspace:enrich-start", () => startEnrichmentTask());

  ipcMain.handle("workspace:preview-status", status("preview"));
  ipcMain.handle("workspace:preview-start", (_event, kind) => startPreviewTask(kind || "preview"));

  // The latest job plus how many photos have colours and how many still
  // need them, for Settings ▸ Library.
  ipcMain.handle("workspace:colors-status", guarded(() => formatJobStatus(null), async () => {
    try {
      const [job, counts] = await Promise.all([latestJobStatus("colors"), commands.colorStatus().catch(() => null)]);
      return { ...job, analyzed: counts?.analyzed || 0, missing: counts?.missing || 0 };
    } catch { return formatJobStatus(null); }
  }));
  ipcMain.handle("workspace:colors-start", (_event, options) => startColorsTask(options || {}));

  // The look-alike index: the latest job plus how many photos have their
  // hash and how many still need one.
  ipcMain.handle("workspace:visual-status", guarded(() => formatJobStatus(null), async () => {
    try {
      const [job, counts] = await Promise.all([latestJobStatus("visual"), commands.visualStatus().catch(() => null)]);
      return { ...job, hashed: counts?.hashed || 0, embedded: counts?.embedded || 0, missing: counts?.missing || 0 };
    } catch { return formatJobStatus(null); }
  }));
  ipcMain.handle("workspace:visual-start", (_event, options) => startVisualTask(options || {}));

  // Reading the shape of older thumbnails (portrait / landscape).
  ipcMain.handle("workspace:orientation-status", status("orientation"));
  ipcMain.handle("workspace:orientation-start", () => startOrientationTask());

  // ── Unified job handling ───────────────────────────────────────────────────
  // All queued/running jobs across every type, formatted for the renderer.
  // A sidecar failure must NOT be swallowed into [] — the renderer's poll reads
  // an empty list as "everything finished" and would fire finish side effects
  // for jobs that are still running, then stop polling. Let it reject so the
  // caller can tell "query failed" apart from "nothing is active".
  ipcMain.handle("workspace:active-jobs", guarded([], () => listActiveJobsFormatted()));

  // Cooperative cancel: flags the job; the runner notices at its next
  // progress checkpoint and exits with status='cancelled'.
  ipcMain.handle("workspace:cancel-job", guarded(null, (_event, jobId) => (jobId ? commands.cancelJob(jobId) : null)));

  // People indexing is intentionally cooperative: it checkpoints only after a
  // complete asset so pausing never commits a partial face set. The generic
  // handlers keep the Activity Center future-proof for other resumable jobs.
  ipcMain.handle("workspace:pause-job", guarded(null, (_event, jobId) => (jobId ? commands.pauseJob(jobId) : null)));

  ipcMain.handle("workspace:resume-job", guarded(null, (_event, jobId) => (jobId ? resumeJob(jobId) : null)));
}

module.exports = { register };
