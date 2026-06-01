// Drives the batch AI-annotation job from the renderer: provider/target
// pre-checks, kicking off the sidecar job, polling its status, surfacing
// progress + toasts, and invalidating the per-asset annotation cache when a
// run finishes so the Inspector shows fresh results.
//
// All annotation entry points (multi-select right-click, folder, "annotate
// all/un-annotated") funnel through the single `annotate()` returned here.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startAnnotationJob,
  getAnnotationJobStatus,
  countAnnotationTargets,
  invalidateAnnotations,
  refreshProviders,
  getHasProvider,
} from "./annotationStore";

const POLL_MS = 1200;

export default function useAnnotationJob(pushToast) {
  const [job, setJob] = useState(null); // { running, processed, total, progress }
  const pollRef = useRef(0);
  const clearTimer = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = 0;
    }
  }, []);

  const poll = useCallback(async () => {
    let status = null;
    try {
      status = await getAnnotationJobStatus();
    } catch {
      clearTimer();
      setJob(null);
      return;
    }
    if (!status) {
      clearTimer();
      setJob(null);
      return;
    }
    const phase = status.result?.current_phase?.result || {};
    const processed = Number(phase.processed || 0);
    const total = Number(phase.total || 0);
    setJob({ running: !!status.running, processed, total, progress: Number(status.progress || 0) });

    if (status.running) {
      pollRef.current = setTimeout(poll, POLL_MS);
      return;
    }

    // Finished — report, refresh, then clear the pill shortly after.
    clearTimer();
    invalidateAnnotations();
    const r = status.result || {};
    if (status.status === "succeeded") {
      const failed = Number(r.failed || 0);
      pushToast?.({
        title: "Annotation complete",
        message: `${Number(r.succeeded || 0)} annotated${failed ? `, ${failed} failed` : ""}.`,
        ttl: 5000,
      });
    } else if (status.status === "failed") {
      pushToast?.({ title: "Annotation failed", message: status.error || "Job failed.", ttl: 7000, tone: "error" });
    }
    setTimeout(() => setJob(null), 2500);
  }, [clearTimer, pushToast]);

  const annotate = useCallback(async (assetIds, opts = {}) => {
    const ids = Array.isArray(assetIds) ? assetIds.filter(Boolean) : [];
    const scope = opts.scope || (opts.collectionId ? "collection" : ids.length ? "selection" : "all");
    const onlyMissing = opts.onlyMissing !== false;
    const payload = {
      scope,
      onlyMissing,
      assetIds: scope === "selection" ? ids : null,
      collectionId: opts.collectionId || null,
    };

    // Provider must be configured.
    await refreshProviders();
    if (getHasProvider() === false) {
      pushToast?.({ title: "No AI provider", message: "Add a provider in Settings → AI first.", ttl: 6000, tone: "error" });
      return;
    }

    // Nothing to do? Don't spawn a job.
    let count = 0;
    try {
      count = await countAnnotationTargets(payload);
    } catch { /* fall through; the job itself will no-op */ }
    if (count === 0) {
      pushToast?.({
        title: "Nothing to annotate",
        message: onlyMissing ? "All targets are already annotated." : "No eligible images.",
        ttl: 4000,
      });
      return;
    }

    try {
      await startAnnotationJob(payload);
      pushToast?.({ title: "Annotating…", message: `${count} image${count > 1 ? "s" : ""} queued.`, ttl: 3000 });
      setJob({ running: true, processed: 0, total: count, progress: 0 });
      clearTimer();
      pollRef.current = setTimeout(poll, 400);
    } catch (e) {
      pushToast?.({ title: "Couldn't start annotation", message: e?.message || "Failed to start.", ttl: 6000, tone: "error" });
    }
  }, [clearTimer, poll, pushToast]);

  // If a job is already running when the app mounts (e.g. reload mid-run),
  // pick the polling back up.
  useEffect(() => {
    let cancelled = false;
    getAnnotationJobStatus()
      .then((s) => {
        if (!cancelled && s?.running) {
          pollRef.current = setTimeout(poll, 400);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [clearTimer, poll]);

  return { job, annotate };
}
