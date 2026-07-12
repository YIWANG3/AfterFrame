// Unified background-activity popover: every running job (import, previews,
// enrichment, AI annotation, AI repaint) with live progress and a cancel
// button, plus the most recent finished job for context. Driven entirely by
// the workspace's unified job poller (workspace.jobs / lastFinishedJob).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
  Activity, X, Ban, FolderInput, Images, Sparkles, Wand2, FileSearch, ScanFace, Pause, Play,
  CheckCircle2, XCircle, CircleSlash,
} from "lucide-react";

export const JOB_META = {
  import: { label: "Import", icon: FolderInput },
  preview: { label: "Previews", icon: Images },
  enrichment: { label: "Enrichment", icon: FileSearch },
  annotation: { label: "AI Annotation", icon: Sparkles },
  ai_repaint: { label: "AI Repaint", icon: Wand2 },
  people_index: { label: "People Recognition", icon: ScanFace },
};

export function jobLine(job, t) {
  const phase = job.result?.current_phase?.result || {};
  const processed = Number(phase.processed || 0);
  const total = Number(phase.total || 0);
  if (job.status === "paused") return t("activity.paused");
  if (total > 0) return t("activity.workingProgress", { label: job.phaseLabel || t("activity.working"), processed, total });
  return job.phaseLabel || (job.status === "queued" ? t("activity.queued") : t("activity.working"));
}

function FinishedRow({ job }) {
  const { t } = useTranslation("nav");
  const meta = JOB_META[job.jobType] || { label: job.jobType, icon: Activity };
  const Icon = job.status === "succeeded" ? CheckCircle2 : job.status === "cancelled" ? CircleSlash : XCircle;
  const tone = job.status === "succeeded" ? "text-green-500" : job.status === "cancelled" ? "text-muted2" : "text-red-400";
  const label = t(`activity.jobs.${job.jobType}`, meta.label);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted2">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 truncate">
        {job.status === "succeeded" ? t("activity.finished", { label }) : t("activity.ended", { label, status: job.status })}
      </span>
    </div>
  );
}

export default function ActivityCenter({ jobs, lastFinishedJob, onCancel, onPause, onResume }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const count = jobs?.length || 0;

  useEffect(() => {
    if (!open) return undefined;
    function down(e) {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function key(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const rect = open ? btnRef.current?.getBoundingClientRect() : null;

  return (
    <>
      <div className="relative">
        <button
          ref={btnRef}
          type="button"
          title={t("activity.tip")}
          onClick={() => setOpen((v) => !v)}
          className={[
            "flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-hover",
            count > 0 || open ? "bg-selected text-accent" : "text-muted hover:text-text",
          ].join(" ")}
        >
          <Activity className="h-3.5 w-3.5 stroke-[1.8]" />
        </button>
        {count > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-black">
            {count}
          </span>
        )}
      </div>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[12000] w-[300px] rounded-lg border border-border/60 bg-chrome shadow-overlay"
          style={{ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 308)) }}
        >
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">
              {t("activity.title")}
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-muted2 hover:bg-hover hover:text-text"
              onClick={() => setOpen(false)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {count === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-muted2">{t("activity.none")}</div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto py-1">
              {jobs.map((job) => {
                const meta = JOB_META[job.jobType] || { label: job.jobType, icon: Activity };
                const Icon = meta.icon;
                const cancelling = !!job.cancel_requested;
                const pausable = job.jobType === "people_index" && !cancelling;
                const paused = job.status === "paused";
                return (
                  <div key={job.jobId} className="px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text">{t(`activity.jobs.${job.jobType}`, meta.label)}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted2">
                        {Math.round((job.progress || 0) * 100)}%
                      </span>
                      {pausable && (
                        <button
                          type="button"
                          title={paused ? t("activity.resume") : t("activity.pause")}
                          onClick={() => (paused ? onResume?.(job.jobId) : onPause?.(job.jobId))}
                          className="shrink-0 rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                        >
                          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                        </button>
                      )}
                      <button
                        type="button"
                        title={cancelling ? t("activity.cancelling") : t("activity.cancel")}
                        disabled={cancelling}
                        onClick={() => onCancel?.(job.jobId)}
                        className={[
                          "shrink-0 rounded p-0.5 transition-colors",
                          cancelling ? "cursor-default text-muted2 opacity-50" : "text-muted2 hover:bg-hover hover:text-red-400",
                        ].join(" ")}
                      >
                        <Ban className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1 truncate pl-[22px] text-[10px] text-muted2">
                      {cancelling ? t("activity.cancelling") : jobLine(job, t)}
                    </div>
                    <div className="ml-[22px] mt-1 h-1 overflow-hidden rounded-full bg-app">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300"
                        style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {lastFinishedJob && (
            <div className="border-t border-border/40 py-0.5">
              <FinishedRow job={lastFinishedJob} />
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
