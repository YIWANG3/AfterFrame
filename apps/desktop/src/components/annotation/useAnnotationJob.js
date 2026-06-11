// Starts batch AI-annotation jobs: provider/target pre-checks, kicking off the
// sidecar job, and seeding the workspace's unified job poller. Progress display
// and completion side effects (cache invalidation, result toast) are handled
// by the unified job pipeline in useWorkspace / App.
//
// All annotation entry points (multi-select right-click, folder, "annotate
// all/un-annotated", auto-on-import) funnel through the single `annotate()`.

import { useCallback } from "react";
import {
  startAnnotationJob,
  countAnnotationTargets,
  refreshProviders,
  getHasProvider,
} from "./annotationStore";

export default function useAnnotationJob(pushToast, pokeJobs) {
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
      const status = await startAnnotationJob(payload);
      pushToast?.({ title: "Annotating…", message: `${count} image${count > 1 ? "s" : ""} queued.`, ttl: 3000 });
      pokeJobs?.(status?.jobId ? { jobId: status.jobId, jobType: "annotation" } : undefined);
    } catch (e) {
      pushToast?.({ title: "Couldn't start annotation", message: e?.message || "Failed to start.", ttl: 6000, tone: "error" });
    }
  }, [pushToast, pokeJobs]);

  return { annotate };
}
