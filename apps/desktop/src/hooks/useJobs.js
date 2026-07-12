// Unified background-job polling, extracted from useWorkspace (review P3-6).
// One self-stopping timer covers ALL job types (import, preview, enrichment,
// annotation, ai_repaint): UI actions and agent broadcasts wake it with
// pokeJobs(seed), it polls while anything is active, dispatches finish side
// effects exactly once per job, then goes back to sleep.
//
// The hook owns polling mechanics only. Domain reactions stay in the caller
// and arrive through `bridgeRef.current` (re-assigned every render, so the
// timer chain never sees stale closures):
//   refreshAll(opts)              reload browser/collections/facets
//   startIncrementalImport(opts)  continue queued import dirs
//   consumeQueuedImport()         → {rawDirs, imageDirs}, clearing the queue
//   mirrorTask(type, task)        legacy per-type task states (import card &c.)

import { useEffect, useRef, useState } from "react";
import api from "../api";

export default function useJobs(bridgeRef) {
  const [activeJobs, setActiveJobs] = useState([]);
  const [lastFinishedJob, setLastFinishedJob] = useState(null);
  const jobsTimerRef = useRef(null);
  const lastJobsJsonRef = useRef("");
  const jobsPollingRef = useRef(false);
  const knownActiveRef = useRef(new Map()); // jobId -> { jobId, jobType, kind }

  async function handleJobFinished(meta) {
    const bridge = bridgeRef.current;
    let final = null;
    try {
      if (meta.jobType === "import") final = await api.getImportStatus();
      else if (meta.jobType === "preview") final = await api.getPreviewStatus();
      else if (meta.jobType === "enrichment") final = await api.getEnrichmentStatus();
      else if (meta.jobType === "annotation") final = await api.getAnnotationJobStatus();
      else if (meta.jobType === "ai_repaint") final = await api.getAiRepaintStatus();
      else if (meta.jobType === "people_index") final = await api.getPeopleIndexStatus();
    } catch { /* sidecar hiccup — still emit the finish event below */ }
    const cancelled = final?.status === "cancelled";

    if (meta.jobType === "import") {
      bridge.mirrorTask("import", final);
      const queued = bridge.consumeQueuedImport() || { rawDirs: [], imageDirs: [], auto: false };
      await bridge.refreshAll({ preserveView: true });
      // Continue queued dirs — but not after a user cancel. auto wins so a queued
      // watched import still honors delete-tombstones (resurrecting a removed
      // file is worse than suppressing one manual re-import).
      if (!cancelled && (queued.rawDirs.length || queued.imageDirs.length)) {
        await bridge.startIncrementalImport({ rawDirs: queued.rawDirs, imageDirs: queued.imageDirs, auto: queued.auto === true });
      }
    } else if (meta.jobType === "preview") {
      // Chain preview-hd only after a SUCCESSFUL small-preview pass — a failed
      // or indeterminate run would just fail again at HD size. HD is opt-in
      // (Settings ▸ Library), so skip the chain when it's off.
      const hdEnabled = (await api.getPreviewSettings().catch(() => null))?.generateHd === true;
      if (hdEnabled && (meta.kind || "preview") === "preview" && final?.status === "succeeded") {
        const hdTask = await api.startPreviewGeneration("preview-hd");
        bridge.mirrorTask("preview", { ...hdTask, _kind: "preview-hd" });
        pokeJobs(hdTask?.jobId ? { jobId: hdTask.jobId, jobType: "preview", kind: "preview-hd" } : undefined);
      } else {
        bridge.mirrorTask("preview", final);
        await bridge.refreshAll({ preserveView: true });
      }
    } else if (meta.jobType === "enrichment") {
      bridge.mirrorTask("enrichment", final);
      await bridge.refreshAll({ preserveView: true });
    } else if (meta.jobType === "ai_repaint") {
      // The job runner registers the repainted file as a new version asset —
      // reload so it appears in the grid without a manual refresh.
      if (!cancelled) await bridge.refreshAll({ preserveView: true });
    }
    // Generic finish event — App-level consumers (annotation toast/cache,
    // activity center) react to this.
    setLastFinishedJob({ ...(final || {}), jobType: meta.jobType, jobId: meta.jobId, finishedAtMs: Date.now() });
  }

  async function pollActiveJobsOnce() {
    let jobs = [];
    try {
      jobs = (await api.getActiveJobs()) || [];
    } catch { jobs = []; }
    // Skip the state churn when nothing actually changed — otherwise every
    // 1.2s tick re-renders the whole tree for the lifetime of a job.
    const jobsJson = JSON.stringify(jobs);
    const changed = jobsJson !== lastJobsJsonRef.current;
    lastJobsJsonRef.current = jobsJson;
    if (changed) {
      setActiveJobs(jobs);
      // Mirror into the legacy per-type task states (import card & friends).
      const byType = new Map(jobs.map((j) => [j.jobType, j]));
      const bridge = bridgeRef.current;
      if (byType.has("import")) bridge.mirrorTask("import", byType.get("import"));
      if (byType.has("preview")) {
        const j = byType.get("preview");
        bridge.mirrorTask("preview", { ...j, _kind: j.kind || knownActiveRef.current.get(j.jobId)?.kind || "preview" });
      }
      if (byType.has("enrichment")) bridge.mirrorTask("enrichment", byType.get("enrichment"));
    }

    // Finish detection: anything we knew about that's no longer active.
    const liveIds = new Set(jobs.map((j) => j.jobId));
    for (const [id, meta] of [...knownActiveRef.current]) {
      if (!liveIds.has(id)) {
        knownActiveRef.current.delete(id);
        void handleJobFinished(meta);
      }
    }
    for (const j of jobs) {
      const prev = knownActiveRef.current.get(j.jobId);
      knownActiveRef.current.set(j.jobId, { jobId: j.jobId, jobType: j.jobType, kind: j.kind || prev?.kind });
    }

    if (jobs.length > 0) {
      jobsTimerRef.current = window.setTimeout(pollActiveJobsOnce, 1200);
    } else {
      jobsPollingRef.current = false;
      jobsTimerRef.current = null;
    }
  }

  // Kick (or re-kick) the poll loop. `seed` pre-registers a just-started job
  // so even one that finishes before the first poll still gets its finish
  // side effects dispatched.
  function pokeJobs(seed) {
    if (seed?.jobId) {
      knownActiveRef.current.set(seed.jobId, { jobId: seed.jobId, jobType: seed.jobType, kind: seed.kind });
    }
    if (jobsPollingRef.current) return;
    jobsPollingRef.current = true;
    jobsTimerRef.current = window.setTimeout(pollActiveJobsOnce, 250);
  }

  async function cancelJob(jobId) {
    if (!jobId) return null;
    const res = await api.cancelJob(jobId);
    pokeJobs();
    return res;
  }

  async function pauseJob(jobId) {
    if (!jobId) return null;
    const res = await api.pauseJob(jobId);
    pokeJobs();
    return res;
  }

  async function resumeJob(jobId) {
    if (!jobId) return null;
    const res = await api.resumeJob(jobId);
    pokeJobs();
    return res;
  }

  // Catalog switches must not carry job state across libraries.
  function resetJobs() {
    knownActiveRef.current.clear();
    lastJobsJsonRef.current = "";
    setActiveJobs([]);
    setLastFinishedJob(null);
  }

  // Recover mid-run jobs after a reload/app start, and clean up on unmount.
  useEffect(() => {
    pokeJobs();
    return () => {
      if (jobsTimerRef.current) clearTimeout(jobsTimerRef.current);
      jobsPollingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { activeJobs, lastFinishedJob, pokeJobs, cancelJob, pauseJob, resumeJob, resetJobs };
}
