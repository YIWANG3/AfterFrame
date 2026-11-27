// What happens around an import, decided in one place (docs/import-pipeline-
// redesign.md §5). Until this, the window did it: when its job poll saw an
// import succeed it started the follow-ups, so an import cancelled half-way,
// one that failed, one that ran while no window was open (an agent's) or
// while the app quit, left its photos without them; and background analysis
// ran on top of imports, every job for itself.
//
// A sweep, run when a job's runner exits, when a catalog opens and every
// half minute (an import a previous run of the app started ends unseen):
//   1. starts the next import queued here, when none runs. The window keeps
//      its own queue (useImportPipeline's pendingImport, which also files
//      what arrives into folders); this one is for the agent's
//      import_directory and the sample catalog, which used to be refused or
//      dropped while an import ran;
//   2. while an import runs, pauses the people scan (a core a worker, and an
//      import keeps most of the cores busy), the app's own pause, which it
//      lifts once imports are over (pause_requested 2, db/jobs.py); the
//      user's pause stays theirs, and a scan the user resumes meanwhile is
//      left to run. The automatic colour, look-alike and orientation
//      catch-ups and batch HD previews asked for meanwhile are noted and
//      started then (tasks.js deferUntilImportsEnd);
//   3. follows up the imports that ended (succeeded, cancelled or failed)
//      with photos they added: people (Settings → People "after import") and
//      annotation (Settings → AI "after import", only the photos those
//      imports added, not every photo of the library without a caption).
//      What it did is written to the import's job row, so each import is
//      followed up once, by whichever run of the app sees it end
//      (db/import_followups.py).
//
// Injected:
//   commands          sidecar verbs (listActiveJobs, pauseJob, pendingImportFollowups, …)
//   tasks             ./tasks.js starters
//   people            ipc/people.js api: startPeopleIndex, resumePeopleIndexJob, canIndex
//   annotation        ipc/annotation.js api: startAnnotationTask, hasProvider
//   readAppSettings, getCatalogPath
//   announce(jobId, jobType)  tells the windows a job started (catalog-changed "jobs")

const PEOPLE = "people_index";
const SWEEP_EVERY_MS = 30_000;
const SWEEP_SOON_MS = 250;

const isActiveImport = (job) => job.job_type === "import" && (job.status === "queued" || job.status === "running");

function createImportPipeline({
  commands,
  tasks,
  people,
  annotation,
  readAppSettings,
  getCatalogPath,
  announce = () => {},
  log = console,
  sweepEveryMs = SWEEP_EVERY_MS,
  sweepSoonMs = SWEEP_SOON_MS,
}) {
  let queue = [];
  const deferred = new Map();
  // Scans the user resumed while an import ran: left to run until imports end.
  const resumedByUser = new Set();
  let sweeping = null;
  let again = false;
  let soon = null;
  let timer = null;

  const startDeferred = {
    colors: (options) => tasks.startColorsTask(options),
    visual: (options) => tasks.startVisualTask(options),
    orientation: () => tasks.startOrientationTask(),
    preview: (options) => tasks.startPreviewTask(options.kind || "preview"),
  };

  // ── imports ──────────────────────────────────────────────────────────────

  // An import for a caller without a queue of its own: started now, or
  // queued behind the one running (`queued: true`, and that import's status).
  async function startImport(options) {
    const status = await tasks.startImportTask(options);
    if (!status?.busy) return status;
    queue.push({ ...options });
    return { ...status, queued: true, queuedImports: queue.length };
  }

  function importStarted() {
    sweepSoon();
  }

  function deferUntilImportsEnd(type, options) {
    if (startDeferred[type]) deferred.set(type, { ...(options || {}) });
  }

  function jobResumed(jobId) {
    if (jobId) resumedByUser.add(String(jobId));
  }

  // ── the sweep ────────────────────────────────────────────────────────────

  function sweepSoon() {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      void sweep();
    }, sweepSoonMs);
    soon.unref?.();
  }

  // One sweep at a time; asked for during one, it runs again after.
  function sweep() {
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again);
      } catch (error) {
        log.warn?.("[pipeline] sweep failed:", error?.message || error);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  }

  async function sweepOnce() {
    if (!getCatalogPath()) return;
    let active = await commands.listActiveJobs();
    let importing = active.some(isActiveImport);

    if (!importing && queue.length) {
      const next = queue.shift();
      const status = await tasks.startImportTask(next);
      if (status?.busy) queue.unshift(next);
      else if (status?.jobId) announce(status.jobId, "import");
      active = await commands.listActiveJobs();
      importing = active.some(isActiveImport);
    }

    if (importing) {
      for (const job of active) {
        if (job.job_type !== PEOPLE || job.cancel_requested || resumedByUser.has(job.job_id)) continue;
        if (job.status === "running" || job.status === "queued") {
          await commands.pauseJob(job.job_id, { forImport: true });
        }
      }
    } else {
      resumedByUser.clear();
      for (const job of active) {
        if (job.job_type === PEOPLE && job.status === "paused" && job.paused_for_import && !job.cancel_requested) {
          const resumed = await people.resumePeopleIndexJob(job.job_id);
          announce(resumed?.jobId || job.job_id, PEOPLE);
        }
      }
      for (const [type, options] of [...deferred]) {
        deferred.delete(type);
        const status = await startDeferred[type](options);
        if (status?.jobId && status.running) announce(status.jobId, type);
      }
      active = await commands.listActiveJobs();
    }

    await followUp(active, importing);
  }

  // The ended imports' people scan and annotation. One scan covers them all
  // (it takes every photo not yet analyzed), once no import runs and no scan
  // is under way: a running one made its list when it started and won't see
  // these photos. One annotation job takes all their photos. What can't
  // start yet is left unrecorded and tried on the next sweep.
  async function followUp(active, importing) {
    const pending = await commands.pendingImportFollowups();
    if (!pending.length) return;
    const settings = readAppSettings() || {};
    const marks = new Map(pending.map((item) => [item.job_id, {}]));
    const withPhotos = pending.filter((item) => item.new_assets > 0);
    for (const item of pending) {
      if (item.new_assets > 0) continue;
      const mark = marks.get(item.job_id);
      if (!item.followups.people) mark.people = "none";
      if (!item.followups.annotation) mark.annotation = "none";
    }

    const forPeople = withPhotos.filter((item) => !item.followups.people);
    if (forPeople.length) {
      let state = null;
      if (!settings.peopleRecognition?.autoIndexOnImport || !people?.canIndex?.()) {
        state = "off";
      } else if (!importing && !active.some((job) => job.job_type === PEOPLE)) {
        try {
          const started = await people.startPeopleIndex({ auto: true });
          announce(started?.jobId, PEOPLE);
          state = "started";
        } catch (error) {
          log.warn?.("[pipeline] people scan after import failed to start:", error?.message || error);
          state = "failed";
        }
      }
      if (state) for (const item of forPeople) marks.get(item.job_id).people = state;
    }

    const forAnnotation = withPhotos.filter((item) => !item.followups.annotation);
    if (forAnnotation.length) {
      let state = null;
      if (!settings.aiAnnotation?.autoOnImport || !(await annotation?.hasProvider?.())) {
        state = "off";
      } else if (!active.some((job) => job.job_type === "annotation")) {
        const importJobIds = forAnnotation.map((item) => item.job_id);
        const count = Number((await commands.annotationCount({ importJobIds }))?.count || 0);
        if (count === 0) {
          state = "none";
        } else {
          try {
            const started = await annotation.startAnnotationTask({ scope: "import", importJobIds, onlyMissing: true, auto: true });
            announce(started?.jobId, "annotation");
            state = "started";
          } catch (error) {
            log.warn?.("[pipeline] annotation after import failed to start:", error?.message || error);
            state = "failed";
          }
        }
      }
      if (state) for (const item of forAnnotation) marks.get(item.job_id).annotation = state;
    }

    for (const item of pending) {
      const mark = marks.get(item.job_id);
      if (!Object.keys(mark).length) continue;
      const done = Boolean((mark.people || item.followups.people) && (mark.annotation || item.followups.annotation));
      await commands.markImportFollowups(item.job_id, { ...mark, done });
    }
  }

  // ── life cycle ───────────────────────────────────────────────────────────

  function start() {
    if (!timer) {
      timer = setInterval(sweepSoon, sweepEveryMs);
      timer.unref?.();
    }
    sweepSoon();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (soon) clearTimeout(soon);
    timer = null;
    soon = null;
  }

  // What was queued or noted belongs to the catalog it was asked for in.
  function catalogChanged() {
    queue = [];
    deferred.clear();
    resumedByUser.clear();
    sweepSoon();
  }

  return {
    startImport,
    importStarted,
    deferUntilImportsEnd,
    jobResumed,
    jobExited: sweepSoon,
    catalogChanged,
    sweep,
    start,
    stop,
    queuedImports: () => queue.length,
  };
}

module.exports = { createImportPipeline };
