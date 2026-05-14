// Inspector block showing AI annotations (caption / tags / location) and
// the per-asset "Annotate with AI" trigger. Loads via IPC, refreshes when
// the user clicks annotate.

import { useCallback, useEffect, useState } from "react";
import { Sparkles, Tag as TagIcon, MapPin, RotateCcw } from "lucide-react";

function Section({ title, badge, action, children }) {
  return (
    <div className="mt-4 border-b border-border/40 pb-3 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">
          {title}
          {badge && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-accent/15 px-1 py-px text-[8px] font-semibold tracking-wider text-accent">
              <span className="h-[3px] w-[3px] rounded-full bg-accent" />
              {badge}
            </span>
          )}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function ConfidencePill({ value }) {
  if (!Number.isFinite(value)) return null;
  return (
    <span className="ml-1 inline-block rounded-sm bg-app px-1 py-px text-[9px] tabular-nums text-muted2">
      {Math.round(value)}%
    </span>
  );
}

export default function AnnotationsSection({
  assetId,
  imagePath,
  onTagClick,
  pushToast,
}) {
  const [annotation, setAnnotation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const fetchAnnotation = useCallback(async () => {
    if (!assetId) { setAnnotation(null); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await window.mediaWorkspace?.getAnnotation?.(assetId);
      setAnnotation(result || null);
    } catch (e) {
      setError(e?.message || "Failed to load annotation");
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => { void fetchAnnotation(); }, [fetchAnnotation]);

  const run = useCallback(async () => {
    if (!assetId || !imagePath) return;
    setRunning(true);
    setError(null);
    try {
      const settings = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      const provider = settings.provider || "anthropic";
      const model = settings.model || "claude-sonnet-4-5";
      const result = await window.mediaWorkspace?.annotateAsset?.({
        assetId,
        imagePath,
        provider,
        model,
        baseUrl: settings.hostUrl || null,
        languages: settings.languages || ["en", "zh"],
        maxTags: settings.maxTags || 10,
        maxCaptionChars: settings.maxCaptionChars || 200,
        customInstructions: settings.customInstructions || null,
      });
      setAnnotation(result || null);
      pushToast?.({ title: "Annotated", message: "AI annotation saved.", ttl: 3500 });
    } catch (e) {
      const msg = e?.message || "Annotation failed";
      setError(msg);
      pushToast?.({ title: "Annotation failed", message: msg, ttl: 6000, tone: "error" });
    } finally {
      setRunning(false);
    }
  }, [assetId, imagePath, pushToast]);

  if (loading && !annotation) {
    return (
      <Section title="AI">
        <div className="text-[11px] text-muted2">Loading…</div>
      </Section>
    );
  }

  // No annotation yet — single CTA.
  if (!annotation) {
    return (
      <Section title="AI">
        <button
          type="button"
          onClick={run}
          disabled={running || !imagePath}
          className={[
            "flex w-full items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5",
            "text-[11px] font-medium text-accent transition-colors",
            running ? "cursor-not-allowed opacity-60" : "hover:bg-accent/20",
          ].join(" ")}
        >
          <Sparkles className="h-3 w-3" />
          {running ? "Annotating…" : "Annotate with AI"}
        </button>
        {error && <div className="mt-2 text-[10px] text-error">{error}</div>}
        <div className="mt-2 text-[10px] leading-snug text-muted2">
          Generates a caption, tags, and a location guess. Configure your provider in Settings → AI.
        </div>
      </Section>
    );
  }

  const loc = annotation.location || null;
  const hasLoc = loc && (loc.country || loc.region || loc.landmark);

  return (
    <>
      <Section
        title="Description"
        badge="AI"
        action={
          <button
            type="button"
            onClick={run}
            disabled={running}
            title="Re-annotate"
            className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text disabled:opacity-50"
          >
            <RotateCcw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
          </button>
        }
      >
        {annotation.caption ? (
          <div className="text-[12px] leading-relaxed text-text">{annotation.caption}</div>
        ) : (
          <div className="text-[11px] italic text-muted2">No caption returned.</div>
        )}
      </Section>

      {annotation.tags?.length > 0 && (
        <Section title="Tags" badge={`AI · ${annotation.tags.length}`}>
          <div className="flex flex-wrap gap-1">
            {annotation.tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTagClick?.(t)}
                title={`Filter by "${t}"`}
                className="inline-flex items-center rounded-full border border-transparent bg-app px-2 py-[2px] text-[10px] text-muted transition-colors hover:border-border hover:bg-hover hover:text-text"
              >
                {t}
              </button>
            ))}
          </div>
        </Section>
      )}

      {hasLoc && (
        <Section title="Location" badge="AI · guess">
          {loc.country && (
            <div className="flex items-start gap-2 text-[11px]">
              <span className="min-w-[50px] text-muted2">Country</span>
              <span className="flex-1 text-text">{loc.country}<ConfidencePill value={loc.confidence} /></span>
            </div>
          )}
          {loc.region && (
            <div className="mt-1 flex items-start gap-2 text-[11px]">
              <span className="min-w-[50px] text-muted2">Region</span>
              <span className="flex-1 text-text">{loc.region}</span>
            </div>
          )}
          {loc.landmark && (
            <div className="mt-1 flex items-start gap-2 text-[11px]">
              <span className="min-w-[50px] text-muted2">Landmark</span>
              <span className="flex-1 text-text">{loc.landmark}</span>
            </div>
          )}
        </Section>
      )}

      {error && <div className="mt-2 text-[10px] text-error">{error}</div>}
    </>
  );
}
