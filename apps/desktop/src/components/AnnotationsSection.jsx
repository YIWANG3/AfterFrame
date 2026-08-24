// Inspector block showing AI annotations (caption / tags / location) and
// the per-asset "Annotate with AI" trigger. Reads from the shared annotation
// store so:
//   - flipping providers in Settings updates the button state instantly
//   - revisiting an already-loaded asset is synchronous (no flicker)

import api from "../api";
import { openDesktopSite } from "./DesktopOnly";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, RotateCcw, ChevronRight, X, Plus, Wand2, MapPinOff, LoaderCircle } from "lucide-react";
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
  // border-t to match Inspector's Section: these render as siblings of the
  // Inspector sections, so a border-b here doubles up with the next section's
  // border-t (last: never fires across the component boundary).
  return (
    <div className="mt-4 border-t border-border/40 pt-3">
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

// Inline tag adder: type to search existing tags (server-side, scales to many)
// or Enter to add a brand-new one.
function TagAdder({ onAdd, existing }) {
  const { t } = useTranslation("annotation");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(async () => {
      const res = (await window.mediaWorkspace?.searchFacet?.({ field: "tag", q: q.trim(), limit: 8 })) || [];
      const have = new Set((existing || []).map((x) => String(x).toLowerCase()));
      setSuggestions(res.filter((r) => !have.has(String(r.value).toLowerCase())));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open, existing]);

  function commit(tag) {
    const v = (tag ?? q).trim();
    if (v) onAdd(v);
    setQ("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border/60 px-2 py-[2px] text-[10px] text-muted2 transition-colors hover:border-border hover:text-text"
      >
        <Plus className="h-2.5 w-2.5" /> {t("add")}
      </button>
    );
  }
  return (
    <div className="relative">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { setQ(""); setOpen(false); }
        }}
        placeholder={t("addTag")}
        className="w-28 rounded-md border border-accent/50 bg-app px-2 py-[2px] text-[10px] text-text outline-none placeholder:text-muted2"
      />
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-44 w-44 overflow-y-auto rounded-md border border-border/60 bg-chrome py-1 shadow-overlay">
          {suggestions.map((s) => (
            <button
              key={s.value}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(s.value); }}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[10px] text-muted hover:bg-hover hover:text-text"
            >
              <span className="truncate">{s.value}</span>
              <span className="shrink-0 text-[9px] tabular-nums text-muted2">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AnnotationsSection({
  assetId,
  imagePath,
  onTagClick,
  onJumpToLocation,
  onLocationChanged,
  pushToast,
}) {
  const { t } = useTranslation("annotation");
  const { hp: hasProvider, ann: annotation, known } = useAnnotationState(assetId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // "Wrong location?" correction popover: a one-line hint re-runs the
  // annotation with the hint outranking visual inference.
  const [hintOpen, setHintOpen] = useState(false);
  const [hintText, setHintText] = useState("");

  useEffect(() => { setHintOpen(false); setHintText(""); }, [assetId]);

  // Kick off any missing data fetches. Provider probe runs once on mount;
  // annotation fetch runs whenever we land on an assetId we haven't cached.
  useEffect(() => {
    if (hasProvider === null) void refreshProviders();
  }, [hasProvider]);

  useEffect(() => {
    setError(null);
    if (assetId && !known) {
      void fetchAnnotationFromStore(assetId).catch((e) => {
        setError(e?.message || t("loadFailed"));
      });
    }
  }, [assetId, known]);

  const run = useCallback(async (options = {}) => {
    if (!assetId || !imagePath) return;
    const hint = typeof options.hint === "string" && options.hint.trim() ? options.hint.trim() : null;
    setRunning(true);
    setError(null);
    try {
      const settings = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      const providers = Array.isArray(settings.providers) ? settings.providers : [];
      const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
      if (!active) {
        throw new Error(t("noProviderError"));
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
        hint,
      });
      setCachedAnnotation(assetId, result || null);
      onLocationChanged?.();
      pushToast?.({ title: t("toast.annotatedTitle"), message: t("toast.annotatedMsg"), ttl: 3500 });
    } catch (e) {
      const msg = e?.message || t("toast.failedMsg");
      setError(msg);
      pushToast?.({ title: t("toast.failedTitle"), message: msg, ttl: 6000, tone: "error" });
    } finally {
      setRunning(false);
    }
  }, [assetId, imagePath, onLocationChanged, pushToast]);

  const addTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await window.mediaWorkspace?.addAssetTag?.(assetId, tag);
      setCachedAnnotation(assetId, updated || null);
    } catch (e) {
      pushToast?.({ title: t("toast.addTagFailed"), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
    }
  }, [assetId, pushToast]);

  const removeTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await window.mediaWorkspace?.removeAssetTag?.(assetId, tag);
      setCachedAnnotation(assetId, updated || null);
    } catch (e) {
      pushToast?.({ title: t("toast.removeTagFailed"), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
    }
  }, [assetId, pushToast]);

  // User veto: null the annotation's location + drop the resolved map point.
  const clearLocation = useCallback(async () => {
    if (!assetId) return;
    try {
      const updated = await window.mediaWorkspace?.clearAiLocation?.(assetId);
      setCachedAnnotation(assetId, updated || null);
      onLocationChanged?.();
      pushToast?.({ title: t("loc.cleared"), ttl: 3500 });
    } catch (e) {
      pushToast?.({ title: t("loc.clearFailed"), message: e?.message || t("toast.failedFallback"), ttl: 5000, tone: "error" });
    }
  }, [assetId, onLocationChanged, pushToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitHint = () => {
    const value = hintText.trim();
    setHintOpen(false);
    setHintText("");
    void run(value ? { hint: value } : {});
  };

  // Still unknown (fetch in flight): render a quiet placeholder matching the
  // CTA's footprint. Showing the CTA here would flash "Annotate with AI" for
  // a beat on every already-annotated asset before the fetch resolves.
  if (!known) {
    return (
      <Section title={t("section.ai")}>
        <div className="h-[30px] w-full animate-pulse rounded-md border border-border/30 bg-app" />
        <div className="mt-2 h-[13px] w-3/4 animate-pulse rounded-sm bg-app" />
      </Section>
    );
  }

  // Known to have no annotation: show the CTA.
  if (!annotation) {
    const providerKnown = hasProvider !== null;
    // Desktop-only on this bridge: the section stays visible as a preview of
    // what the desktop app offers; the button opens the download page.
    if (!api.can("annotation")) {
      return (
        <Section title={t("section.ai")}>
          <button
            type="button"
            onClick={openDesktopSite}
            title={t("desktop.hint", { ns: "common" })}
            className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border/40 bg-app px-3 py-1.5 text-[11px] font-medium text-muted2 transition-colors hover:text-muted"
          >
            <Sparkles className="h-3 w-3" />
            {t("annotate")}
          </button>
          <div className="mt-2 text-[10px] leading-snug text-muted2">
            {t("desktop.hint", { ns: "common" })}
          </div>
        </Section>
      );
    }
    const enabled = providerKnown && hasProvider && !running && !!imagePath;
    return (
      <Section title={t("section.ai")}>
        <button
          type="button"
          onClick={() => run()}
          disabled={!enabled}
          title={providerKnown && !hasProvider ? t("configureTip") : undefined}
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
          {running ? t("annotating") : t("annotate")}
        </button>
        {error && <div className="mt-2 text-[10px] text-error">{error}</div>}
        <div className="mt-2 text-[10px] leading-snug text-muted2">
          {providerKnown && !hasProvider
            ? t("configureHint")
            : t("generatesHint")}
        </div>
      </Section>
    );
  }

  const loc = annotation.location || null;
  const hasLoc = loc && (loc.country || loc.region || loc.landmark);

  return (
    <>
      <Section
        title={t("section.description")}
        badge={t("badge.ai")}
        collapsible
        action={
          <button
            type="button"
            onClick={() => run()}
            disabled={running || !hasProvider}
            title={!hasProvider ? t("configureTip") : t("reanalyzeTip")}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-muted2 transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
            {running ? t("analyzing") : t("analyzeAgain")}
          </button>
        }
      >
        {annotation.caption ? (
          <div className="text-[12px] leading-relaxed text-text">{annotation.caption}</div>
        ) : (
          <div className="text-[11px] italic text-muted2">{t("noCaption")}</div>
        )}
      </Section>

      <Section title={t("section.tags")} badge={annotation.tags?.length ? `${annotation.tags.length}` : undefined} collapsible>
        <div className="flex flex-wrap items-center gap-1">
          {(annotation.tags || []).map((tag) => (
            <span
              key={tag}
              className="group/tag inline-flex items-center rounded-md border border-transparent bg-app px-2 py-[2px] text-[10px] text-muted transition-colors hover:border-border hover:text-text"
            >
              <button
                type="button"
                onClick={() => onTagClick?.(tag)}
                title={t("filterBy", { tag })}
                className="hover:text-text"
              >
                {tag}
              </button>
              <button
                type="button"
                onClick={() => removeTag(tag)}
                title={t("removeTag")}
                className="ml-0.5 hidden rounded p-px text-muted2 transition-colors hover:text-red-400 group-hover/tag:inline-flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <TagAdder onAdd={addTag} existing={annotation.tags || []} />
        </div>
      </Section>

      {hasLoc && (() => {
        // Every row jumps to the same resolved point — the click affordance
        // is the row value itself, mirroring the Inspector's GPS row.
        const locValue = (content) => (onJumpToLocation ? (
          <button
            type="button"
            onClick={() => onJumpToLocation(assetId)}
            title={t("loc.jumpTip")}
            className="flex-1 cursor-pointer text-left text-text transition-colors hover:text-accent"
          >
            {content}
          </button>
        ) : (
          <span className="flex-1 text-text">{content}</span>
        ));
        return (
          <Section
            title={t("section.location")}
            badge={t("badge.guess")}
            collapsible
            action={
              <div className="relative flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setHintOpen((v) => !v)}
                  disabled={running}
                  title={t("loc.hintTip")}
                  className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text disabled:opacity-40"
                >
                  {running ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => void clearLocation()}
                  disabled={running}
                  title={t("loc.clearTip")}
                  className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-red-400 disabled:opacity-40"
                >
                  <MapPinOff className="h-3 w-3" />
                </button>
                {hintOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-border/60 bg-chrome p-2 shadow-overlay">
                    <div className="mb-1 text-[10px] leading-snug text-muted2">{t("loc.hintLabel")}</div>
                    <input
                      autoFocus
                      value={hintText}
                      onChange={(e) => setHintText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitHint();
                        else if (e.key === "Escape") { setHintOpen(false); setHintText(""); }
                      }}
                      placeholder={t("loc.hintPlaceholder")}
                      className="w-full rounded-md border border-accent/50 bg-app px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted2"
                    />
                    <div className="mt-1.5 flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => { setHintOpen(false); setHintText(""); }}
                        className="rounded px-1.5 py-0.5 text-[10px] text-muted2 transition-colors hover:bg-hover hover:text-text"
                      >
                        {t("loc.hintCancel")}
                      </button>
                      <button
                        type="button"
                        onClick={submitHint}
                        className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/25"
                      >
                        {t("loc.hintRun")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            }
          >
            {loc.country && (
              <div className="flex items-start gap-2 text-[11px]">
                <span className="min-w-[50px] text-muted2">{t("loc.country")}</span>
                {locValue(<>{loc.country}<ConfidencePill value={loc.confidence} /></>)}
              </div>
            )}
            {loc.admin1 && (
              <div className="mt-1 flex items-start gap-2 text-[11px]">
                <span className="min-w-[50px] text-muted2">{t("loc.admin1")}</span>
                {locValue(loc.admin1)}
              </div>
            )}
            {loc.locality && (
              <div className="mt-1 flex items-start gap-2 text-[11px]">
                <span className="min-w-[50px] text-muted2">{t("loc.locality")}</span>
                {locValue(loc.locality)}
              </div>
            )}
            {loc.region && (
              <div className="mt-1 flex items-start gap-2 text-[11px]">
                <span className="min-w-[50px] text-muted2">{t("loc.region")}</span>
                {locValue(loc.region)}
              </div>
            )}
            {loc.landmark && (
              <div className="mt-1 flex items-start gap-2 text-[11px]">
                <span className="min-w-[50px] text-muted2">{t("loc.landmark")}</span>
                {locValue(loc.landmark)}
              </div>
            )}
          </Section>
        );
      })()}

      {error && <div className="mt-2 text-[10px] text-error">{error}</div>}
    </>
  );
}
