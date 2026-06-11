// THE single ambient progress surface: one compact card per running
// background job, stacked in the bottom-right corner. Replaces the old
// bottom-left ImportOverlay card and the bottom-right annotation pill.
// Detailed history / management lives in the Toolbar's ActivityCenter.

import { JOB_META, jobLine } from "./ActivityCenter";
import { Activity } from "lucide-react";

// `inline` skips the fixed positioning so the dock can live inside a shared
// bottom-corner container (alongside the ToastStack) without overlapping it.
export default function JobDock({ jobs, queuedNote, onCancel, inline = false }) {
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
        return (
          <div
            key={job.jobId}
            className="relative overflow-hidden rounded-lg border border-border bg-panel2 p-3 pl-4 shadow-overlay ring-1 ring-black/40"
          >
            {/* Accent edge so the card reads as "activity" against any panel */}
            <div className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
            <div className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text">
                {meta.label}
                {isImport && job.phaseCount > 1 ? ` · ${job.phaseIndex}/${job.phaseCount}` : ""}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted2">
                {Math.round((job.progress || 0) * 100)}%
              </span>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => onCancel?.(job.jobId)}
                className={[
                  "shrink-0 rounded px-1 text-[10px] transition-colors",
                  cancelling ? "cursor-default text-muted2 opacity-50" : "text-muted2 hover:bg-hover hover:text-red-400",
                ].join(" ")}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </div>
            <div className="mt-1 truncate pl-[22px] text-[10px] text-muted2">{jobLine(job)}</div>
            {isImport && queuedNote ? (
              <div className="mt-0.5 truncate pl-[22px] text-[10px] text-muted2">{queuedNote}</div>
            ) : null}
            <div className="ml-[22px] mt-1.5 h-1 overflow-hidden rounded-full bg-app">
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
