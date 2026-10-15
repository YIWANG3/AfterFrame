// Starts batch AI-annotation jobs: provider/target pre-checks, kicking off the
// sidecar job, and seeding the workspace's unified job poller. Progress display
// and completion side effects (cache invalidation, result toast) are handled
// by the unified job pipeline in useWorkspace / App.
//
// All annotation entry points (multi-select right-click, folder, "annotate
// all/un-annotated", auto-on-import) funnel through the single `annotate()`.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  startAnnotationJob,
  countAnnotationTargets,
  refreshProviders,
  getHasProvider,
} from "./annotationStore";

export default function useAnnotationJob(pushToast, pokeJobs) {
  const { t } = useTranslation("annotation");
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
      pushToast?.({ title: t("job.noProviderTitle"), message: t("job.noProviderMsg"), ttl: 6000, tone: "error" });
      return;
    }

    // Nothing to do? Don't spawn a job.
    let count = 0;
    try {
      count = await countAnnotationTargets(payload);
    } catch { /* fall through; the job itself will no-op */ }
    if (count === 0) {
      pushToast?.({
        title: t("job.nothingTitle"),
        message: t(onlyMissing ? "job.allAnnotated" : "job.noEligible"),
        ttl: 4000,
      });
      return;
    }

    try {
      const status = await startAnnotationJob(payload);
      // No start toast — the JobDock progress card appears immediately and
      // a duplicate notification would just stack on top of it.
      pokeJobs?.(status?.jobId ? { jobId: status.jobId, jobType: "annotation" } : undefined);
    } catch (e) {
      pushToast?.({ title: t("job.startFailed"), message: e?.message || t("job.startFailedMsg"), ttl: 6000, tone: "error" });
    }
  }, [pushToast, pokeJobs, t]);

  return { annotate };
}
