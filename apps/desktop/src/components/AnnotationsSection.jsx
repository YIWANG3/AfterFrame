// Inspector block showing AI annotations (caption / tags / location) and
// the per-asset "Annotate with AI" trigger. Reads from the shared annotation
// store so:
//   - flipping providers in Settings updates the button state instantly
//   - revisiting an already-loaded asset is synchronous (no flicker)

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Sparkles, RotateCcw, ChevronRight } from "lucide-react";
import {
  subscribe,
  getVersion,
  getHasProvider,
  refreshProviders,
  getCachedAnnotation,
  setCachedAnnotation,
  fetchAnnotation as fetchAnnotationFromStore,
} from "./annotation/annotationStore";

function SectionLabel({ title, badge }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">
      {title}
      {badge && (
        <span className="inline-flex items-center gap-1 rounded-sm bg-accent/15 px-1 py-px text-[8px] font-semibold tracking-wider text-accent">
          <span className="h-[3px] w-[3px] rounded-full bg-accent" />
          {badge}
        </span>
      )}
    </span>
  );
}

function Section({ title, badge, action, collapsible = false, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-b border-border/40 pb-3 last:border-b-0">
      <div className="flex items-center justify-between">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex flex-1 items-center gap-1 text-left"
          >
            <ChevronRight className={`h-3 w-3 shrink-0 text-muted2 transition-transform ${open ? "rotate-90" : ""}`} />
            <SectionLabel title={title} badge={badge} />
          </button>
        ) : (
          <SectionLabel title={title} badge={badge} />
        )}
        {action}
      </div>
      {(!collapsible || open) && <div className="mt-1.5">{children}</div>}
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

// Subscribe to store version, then pull live values via getters. Snapshot is
// a stable number — React only re-renders when notify() bumps the version.
function useAnnotationState(assetId) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const cached = getCachedAnnotation(assetId);
  return {
    hp: getHasProvider(),
    ann: cached === undefined ? null : cached,
    known: cached !== undefined,
  };
}

export default function AnnotationsSection({
  assetId,
  imagePath,
  onTagClick,
  pushToast,
}) {
  const { hp: hasProvider, ann: annotation, known } = useAnnotationState(assetId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  // Kick off any missing data fetches. Provider probe runs once on mount;
  // annotation fetch runs whenever we land on an assetId we haven't cached.
  useEffect(() => {
    if (hasProvider === null) void refreshProviders();
  }, [hasProvider]);

  useEffect(() => {
    setError(null);
    if (assetId && !known) {
      void fetchAnnotationFromStore(assetId).catch((e) => {
        setError(e?.message || "Failed to load annotation");
      });
    }
  }, [assetId, known]);

  const run = useCallback(async () => {
    if (!assetId || !imagePath) return;
    setRunning(true);
    setError(null);
    try {
      const settings = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      const providers = Array.isArray(settings.providers) ? settings.providers : [];
      const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
      if (!active) {
        throw new Error("No provider configured. Open Settings → AI to add one.");
      }
      // Sidecar adapters only know two: anthropic + openai_compatible. OpenAI
      // and Google route through openai_compatible (URL inferred at the sidecar).
      const sidecarProvider = active.type === "anthropic" ? "anthropic" : "openai_compatible";
      const result = await window.mediaWorkspace?.annotateAsset?.({
        assetId,
        imagePath,
        providerId: active.id,
        provider: sidecarProvider,
        model: active.model,
        baseUrl: active.baseUrl || null,
        languages: settings.languages || ["en", "zh"],
        maxTags: settings.maxTags || 10,
        maxCaptionChars: settings.maxCaptionChars || 200,
        customInstructions: settings.customInstructions || null,
      });
      setCachedAnnotation(assetId, result || null);
      pushToast?.({ title: "Annotated", message: "AI annotation saved.", ttl: 3500 });
    } catch (e) {
      const msg = e?.message || "Annotation failed";
      setError(msg);
      pushToast?.({ title: "Annotation failed", message: msg, ttl: 6000, tone: "error" });
    } finally {
      setRunning(false);
    }
  }, [assetId, imagePath, pushToast]);

  // No annotation (or still unknown): show the CTA. Layout is stable across
  // unknown→known transitions so switching assets doesn't flicker.
  if (!annotation) {
    const providerKnown = hasProvider !== null;
    const enabled = providerKnown && hasProvider && !running && !!imagePath;
    return (
      <Section title="AI">
        <button
          type="button"
          onClick={run}
          disabled={!enabled}
          title={providerKnown && !hasProvider ? "Configure a provider in Settings → AI" : undefined}
          className={[
            "flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5",
            "text-[11px] font-medium transition-colors",
            !enabled && providerKnown && !hasProvider
              ? "cursor-not-allowed border-border/40 bg-app text-muted2"
              : running
                ? "cursor-not-allowed border-accent/40 bg-accent/10 text-accent opacity-60"
                : enabled
                  ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                  : "cursor-not-allowed border-border/40 bg-app text-muted2 opacity-60",
          ].join(" ")}
        >
          <Sparkles className="h-3 w-3" />
          {running ? "Annotating…" : "Annotate with AI"}
        </button>
        {error && <div className="mt-2 text-[10px] text-error">{error}</div>}
        <div className="mt-2 text-[10px] leading-snug text-muted2">
          {providerKnown && !hasProvider
            ? "Configure your provider in Settings → AI to enable annotation."
            : "Generates a caption, tags, and a location guess."}
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
        collapsible
        action={
          <button
            type="button"
            onClick={run}
            disabled={running || !hasProvider}
            title={!hasProvider ? "Configure a provider in Settings → AI" : "Re-analyze this image"}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-muted2 transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
            {running ? "Analyzing…" : "Analyze again"}
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
        <Section title="Tags" badge={`AI · ${annotation.tags.length}`} collapsible>
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
        <Section title="Location" badge="AI · guess" collapsible>
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
