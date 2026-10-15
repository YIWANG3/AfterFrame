// Background jobs: starting annotation, and watching / steering any job.
// Shape and ctx: see tools/index.js.

module.exports = (ctx) => {
  const { deps, commands, getCatalogState, formatJobStatus, requireCatalog } = ctx;
  return [
    {
      name: "annotate_assets",
      description:
        "Run AI auto-annotation (caption + tags + OCR text) over assets using the provider configured in the app's " +
        "Settings → AI. Scope: pass asset_ids, or collection_id, or neither for the whole library. " +
        "Skips already-annotated assets unless reannotate=true. Long-running: returns a job_id — " +
        "poll get_job_status; results then feed free-text search.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          collection_id: { type: "string" },
          reannotate: { type: "boolean", description: "Overwrite existing annotations. Default false" },
        },
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startAnnotationTask) throw new Error("Annotation bridge unavailable.");
        const assetIds = (args.asset_ids || []).map(String).filter(Boolean);
        const scope = assetIds.length ? "selection" : args.collection_id ? "collection" : "all";
        const status = await deps.startAnnotationTask({
          scope,
          assetIds,
          collectionId: args.collection_id || null,
          onlyMissing: !args.reannotate,
        });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "annotation" });
        return {
          job_id: status.jobId,
          status: status.status,
          running: status.running,
          note: "Annotation runs in the background — poll get_job_status. The job is visible in the app's JobDock.",
        };
      },
    },
    {
      name: "get_job_status",
      description: "Status of a background job by job_id (returned by import_directory / list_active_jobs).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        return formatJobStatus(await commands.getJob(args.job_id));
      },
    },
    {
      name: "list_active_jobs",
      description: "All queued or running background jobs (import, enrichment, preview, ai_repaint, annotation).",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const { currentCatalogPath, catalogHasDb } = getCatalogState();
        if (!currentCatalogPath || !catalogHasDb()) return { jobs: [] };
        if (!deps.listActiveJobsFormatted) throw new Error("Jobs bridge unavailable.");
        return { jobs: await deps.listActiveJobsFormatted() };
      },
    },
    {
      name: "cancel_job",
      description: "Request cooperative cancellation of a running job. The runner stops at its next checkpoint.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.cancelJob(String(args.job_id));
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
    {
      name: "pause_job",
      description: "Pause a running job at its next checkpoint (resumable later with resume_job).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        const result = await commands.pauseJob(String(args.job_id));
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
    {
      name: "resume_job",
      description: "Resume a paused job.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      async handler(args) {
        requireCatalog();
        // Same routing as the app's Activity Center resume button (tasks.resumeJob).
        if (!deps.resumeJob) throw new Error("Jobs bridge unavailable.");
        const result = await deps.resumeJob(String(args.job_id));
        deps.broadcastCatalogChanged?.("jobs");
        return result;
      },
    },
  ];
};
