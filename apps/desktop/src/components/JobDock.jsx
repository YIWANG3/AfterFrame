// THE single ambient progress surface: one compact card per running
// background job, stacked in the bottom-right corner. Replaces the old
// bottom-left ImportOverlay card and the bottom-right annotation pill.
// Detailed history / management lives in the Toolbar's ActivityCenter.

import { useTranslation } from "react-i18next";
import { JOB_META, jobLine } from "./ActivityCenter";
import { Activity, Pause, Play } from "lucide-react";

// `inline` skips the fixed positioning so the dock can live inside a shared
// bottom-corner container (alongside the ToastStack) without overlapping it.
export default function JobDock({ jobs, queuedNote, onCancel, onPause, onResume, inline = false }) {
  const { t } = useTranslation("nav");
  const list = jobs || [];
  if (!list.length) return null;
  return (
    <div className={[
      "flex w-[340px] flex-col gap-2",
      inline ? "" : "fixed bottom-4 right-4 z-[11000]",
    ].join(" ")}>
      {list.map((job) => {
        const meta = JOB_META[job.jobType] || { label: job.jobType, icon: Activity };
        const Icon = meta.icon;
        const cancelling = !!job.cancel_requested;
        const isImport = job.jobType === "import";
        const pausable = job.jobType === "people_index" && !cancelling;
        const paused = job.status === "paused";
        return (
          <div
            key={job.jobId}
            data-testid="job-dock-card"
            className="floating-status-card relative overflow-hidden p-3"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text">
                {t(`activity.jobs.${job.jobType}`, meta.label)}
                {isImport && job.phaseCount > 1 ? ` · ${job.phaseIndex}/${job.phaseCount}` : ""}
              </span>
              <span className="shrink-0 text-[10px] font-medium tabular-nums text-text">
                {Math.round((job.progress || 0) * 100)}%
              </span>
              {pausable && (
                <button
                  type="button"
                  onClick={() => (paused ? onResume?.(job.jobId) : onPause?.(job.jobId))}
                  className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  title={paused ? t("activity.resume") : t("activity.pause")}
                >
                  {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                </button>
              )}
              <button
                type="button"
                disabled={cancelling}
                onClick={() => onCancel?.(job.jobId)}
                className={[
                  "shrink-0 rounded px-1 text-[10px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  cancelling ? "cursor-default text-muted2 opacity-50" : "text-muted hover:bg-hover hover:text-red-400",
                ].join(" ")}
              >
                {cancelling ? t("activity.cancelling") : t("activity.cancel")}
              </button>
            </div>
            <div className="mt-1 truncate pl-[22px] text-[10px] text-muted">{jobLine(job, t)}</div>
            {isImport && queuedNote ? (
              <div className="mt-0.5 truncate pl-[22px] text-[10px] text-muted">{queuedNote}</div>
            ) : null}
            <div className="job-dock-track ml-[22px] mt-1.5 h-1.5 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
