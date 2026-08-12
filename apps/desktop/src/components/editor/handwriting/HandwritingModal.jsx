// AI handwriting sticker generator. Text (+ optional style reference image) →
// text-to-image job (black ink on white) → local luminance matte + colorize →
// sticker layer. Prompt language follows the input text (CJK → Chinese
// template, otherwise English) — the text itself is never translated.
// Providers are picked from the shared AI provider instances; credentials are
// managed in Settings only — an unconfigured provider shows a hint instead of
// a key field.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, Loader2, ImagePlus, ChevronDown } from "lucide-react";
import Modal from "../../../ui/Modal";
import ColorPickerPopover from "../../collage/ColorPickerPopover";
import {
  HANDWRITING_STYLES,
  promptForPreset,
  promptForReference,
  isCjkText,
  aspectForText,
  normalizeHandwritingText,
  TEXT_IMAGE_DEFAULT_MODELS,
  TEXT_IMAGE_CAPABLE_TYPES,
} from "./styles";
import { matteHandwriting, colorizeHandwriting, loadHandwritingImage } from "../render/handwritingMatte";
import { localFileUrl as mediaUrlFor } from "../../../utils/format";

const FIELD =
  "h-8 w-full rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none hover:border-border focus:border-accent/50";

const COLOR_SWATCHES = ["#ffffff", "#000000", "#e8c547", "#f7c6d6", "#e05252", "#4f8fe0"];

async function waitForTextImageJob(startStatus, isAlive = () => true) {
  // Cache hits come back already succeeded (jobId null); live jobs are polled
  // until the latest text_image job leaves the running state. Returns null if
  // the caller went away (modal closed) — the job itself keeps running in the
  // main process and lands in the cache for next time.
  if (!startStatus?.running && startStatus?.status === "succeeded") return startStatus;
  if (!startStatus?.running && startStatus?.status === "failed") {
    throw new Error(startStatus?.error || "generation failed");
  }
  for (;;) {
    await new Promise((res) => setTimeout(res, 1200));
    if (!isAlive()) return null;
    const task = await window.mediaWorkspace?.getTextImageStatus?.();
    if (task?.running) continue;
    if (task?.status === "succeeded" && task?.result?.output_path) return task;
    throw new Error(task?.error || "generation failed");
  }
}

export default function HandwritingModal({ onAdd, onClose }) {
  const { t } = useTranslation("editor");
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState("");
  const [providerConfigured, setProviderConfigured] = useState(null);
  const [modelsByProvider, setModelsByProvider] = useState({});
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [styleId, setStyleId] = useState(HANDWRITING_STYLES[0].id);
  const [presetsExpanded, setPresetsExpanded] = useState(false);
  const [refPath, setRefPath] = useState(null);
  // The prompt textarea is the single source of truth for what gets sent:
  // preset clicks and reference selection FILL it (with a literal {text}
  // placeholder so the text field stays live), and the user can edit it
  // freely or paste a full shared prompt (口令).
  const [promptText, setPromptText] = useState(() => promptForPreset(HANDWRITING_STYLES[0]));
  // Fill for the matted glyphs — solid or linear gradient, applied locally
  // (colorizeHandwriting), so switching is instant and free.
  const [fill, setFill] = useState({
    mode: "solid",
    color: "#ffffff",
    opacity: 100,
    gradient: { from: "#ffd76a", fromOpacity: 1, to: "#ff7a59", toOpacity: 1, angle: 90 },
  });
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const fillSwatchRef = useRef(null);
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState(null); // {rawPath, alphaCanvas, width, height}
  const [error, setError] = useState(null);
  const resultRef = useRef(null);
  const aliveRef = useRef(true);
  // "Regenerate" must not hit the params cache — bump the seed per attempt.
  const seedRef = useRef(0);
  // Re-arm on every (re)mount: StrictMode dev double-invokes effects
  // (mount → cleanup → mount), so a cleanup-only effect would leave the ref
  // permanently false in dev and silently kill generation.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const providerType = providers.find((p) => p.id === providerId)?.type || "nanobanana";

  // The result block sits at the bottom of the scroll area — bring it into
  // view when generation starts/finishes so the outcome is never hidden.
  useEffect(() => {
    if (generating || candidate) {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [generating, candidate]);

  // Generic reference template for user-uploaded refs; language follows the
  // text being written (CJK → Chinese; empty defaults to Chinese).
  const refTemplate = () => promptForReference("{text}", text.trim() && !isCjkText(text) ? "en" : "zh");
  // Everything we might auto-fill; a prompt matching none of these is
  // hand-edited and must never be clobbered.
  const knownTemplates = () => [
    ...HANDWRITING_STYLES.map((s) => promptForPreset(s)),
    promptForReference("{text}", "zh"),
    promptForReference("{text}", "en"),
    "",
  ];

  // Reference set/clear swaps between the generic template and the selected
  // preset's own recipe (unless the user hand-edited the prompt).
  useEffect(() => {
    setPromptText((prev) => {
      if (!knownTemplates().includes(prev)) return prev;
      if (refPath) return refTemplate();
      const style = HANDWRITING_STYLES.find((s) => s.id === styleId) || HANDWRITING_STYLES[0];
      return promptForPreset(style);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refPath, isCjkText(text)]);

  useEffect(() => {
    (async () => {
      const prefs = (await window.mediaWorkspace?.getAiPreferences?.()) || {};
      const capable = (prefs.providers || []).filter((p) => TEXT_IMAGE_CAPABLE_TYPES.has(p.type));
      setProviders(capable);
      setModelsByProvider(prefs.modelsCache || {});
      const initial = capable.find((p) => p.id === prefs.activeProvider) || capable[0];
      if (initial) setProviderId(initial.id);
    })();
  }, []);

  // Advisory precheck only (drives the settings hint) — it never blocks the
  // button: dev builds can't read the packaged app's keychain tokens yet may
  // have an env-var fallback, and a truly missing key still fails at
  // generation time with the same friendly message.
  useEffect(() => {
    if (!providerId) return;
    if (providerType === "mock") {
      setProviderConfigured(true);
      return;
    }
    let cancelled = false;
    setProviderConfigured(null);
    (async () => {
      try {
        const config = await window.mediaWorkspace?.getAiProviderToken?.(providerId);
        if (!cancelled) setProviderConfigured(Boolean(config?.token));
      } catch {
        if (!cancelled) setProviderConfigured(null);
      }
    })();
    return () => { cancelled = true; };
  }, [providerId, providerType]);

  // providerId included: switching between two providers of the SAME type must
  // also reset the model — the old provider's model id may not exist there.
  useEffect(() => {
    setModel(TEXT_IMAGE_DEFAULT_MODELS[providerType] || "");
  }, [providerId, providerType]);

  const modelOptions = useMemo(() => {
    const cached = modelsByProvider[providerId] || [];
    const fallback = TEXT_IMAGE_DEFAULT_MODELS[providerType];
    const ids = new Set(cached.map((m) => m.id));
    const merged = [...cached];
    if (fallback && !ids.has(fallback)) merged.unshift({ id: fallback, name: fallback });
    return merged;
  }, [modelsByProvider, providerId, providerType]);

  // If the prompt still references {text}, the text field must be filled;
  // a fully hand-written prompt can stand alone.
  const needsText = promptText.includes("{text}");
  const canGenerate =
    Boolean(promptText.trim()) &&
    (!needsText || Boolean(text.trim())) &&
    providers.length > 0 &&
    !generating;

  const effectiveFill = useMemo(
    () =>
      fill.mode === "gradient"
        ? { mode: "gradient", ...fill.gradient, opacity: fill.opacity ?? 100 }
        : { mode: "solid", color: fill.color, opacity: fill.opacity ?? 100 },
    [fill]
  );
  // Colorize is a cheap fillRect; the expensive part is PNG-encoding the
  // result. Preview draws the canvas directly and the data: URL is only
  // encoded once, in addToCanvas.
  const recoloredCanvas = useMemo(
    () => (candidate ? colorizeHandwriting(candidate.alphaCanvas, effectiveFill) : null),
    [candidate, effectiveFill]
  );
  const previewCanvasRef = useRef(null);
  useEffect(() => {
    const el = previewCanvasRef.current;
    if (!el || !recoloredCanvas) return;
    el.width = recoloredCanvas.width;
    el.height = recoloredCanvas.height;
    el.getContext("2d").drawImage(recoloredCanvas, 0, 0);
  }, [recoloredCanvas]);

  async function pickReference() {
    const picked = await window.mediaWorkspace?.pickHandwritingRef?.();
    if (picked) setRefPath(picked);
  }

  async function generate() {
    if (!canGenerate) return;
    setError(null);
    setCandidate(null);
    setGenerating(true);
    try {
      const prompt = promptText.trim().replaceAll("{text}", normalizeHandwritingText(text));
      const aspectRatio = text.trim() ? aspectForText(text) : "16:9";
      // User-uploaded reference wins; otherwise the selected preset's bundled
      // sample drives the style. Resolution failure (e.g. missing asset) just
      // degrades to prompt-only generation.
      let effectiveRef = refPath;
      if (!effectiveRef) {
        try {
          effectiveRef = (await window.mediaWorkspace?.getHandwritingPresetRef?.(styleId)) || null;
        } catch {
          effectiveRef = null;
        }
      }
      const seed = seedRef.current++;
      const start = await window.mediaWorkspace?.startTextImage?.({
        provider: providerId,
        providerType,
        prompt,
        model,
        aspectRatio,
        quality: providerType === "openai" || providerType === "openai_compatible" ? "medium" : null,
        refImagePath: effectiveRef,
        seed,
      });
      const done = await waitForTextImageJob(start, () => aliveRef.current);
      if (!done) return; // modal closed mid-generation
      const rawPath = done.result.output_path;
      const img = await loadHandwritingImage(mediaUrlFor(rawPath));
      // Check BEFORE the per-pixel matte, not just after — a closed modal
      // shouldn't pay for a full-image pass it will throw away.
      if (!aliveRef.current) return;
      const alphaCanvas = matteHandwriting(img);
      if (!alphaCanvas) throw new Error(t("handwriting.emptyResult"));
      setCandidate({ rawPath, alphaCanvas, width: alphaCanvas.width, height: alphaCanvas.height });
    } catch (err) {
      if (aliveRef.current) {
        const message = String(err?.message || err);
        if (message.includes("No API token")) {
          setProviderConfigured(false);
          setError(t("handwriting.notConfigured"));
        } else {
          setError(message);
        }
      }
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  }

  function addToCanvas() {
    if (!candidate || !recoloredCanvas) return;
    onAdd({
      stickerPath: recoloredCanvas.toDataURL("image/png"),
      naturalWidth: candidate.width,
      naturalHeight: candidate.height,
      sourceLabel: text.trim() || promptText.trim().slice(0, 20),
      handwriting: {
        rawPath: candidate.rawPath,
        text: text.trim(),
        prompt: promptText.trim(),
        styleId: refPath ? null : styleId,
        refImagePath: refPath,
        provider: providerType,
        model,
        fill: effectiveFill,
      },
    });
  }

  return (
    <Modal onClose={onClose} className="max-w-[460px]">
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">
          {t("handwriting.title")}
        </div>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex max-h-[72vh] flex-col gap-3 overflow-y-auto px-4 py-3">
        <input
          type="text"
          className={`${FIELD} shrink-0`}
          value={text}
          maxLength={40}
          placeholder={t("handwriting.textPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          data-testid="handwriting-text-input"
        />

        {/* Style presets — each is a bundled reference image; the selected one
            is sent as the style reference. Collapsed = one scrollable strip
            (like the frame presets); chevron expands the full grid. Dimmed
            while a user-uploaded reference drives the style instead. */}
        <div className={refPath ? "pointer-events-none opacity-35" : ""}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">
              {t("handwriting.presets")}
            </span>
            <button
              type="button"
              onClick={() => setPresetsExpanded((v) => !v)}
              className="flex h-5 w-5 items-center justify-center rounded text-muted2 hover:bg-hover hover:text-text"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${presetsExpanded ? "rotate-180" : ""}`} />
            </button>
          </div>
          <div className={presetsExpanded ? "grid grid-cols-3 gap-1.5" : "flex gap-1.5 overflow-x-auto pb-1"}>
            {HANDWRITING_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setStyleId(s.id);
                  // Explicit user action — always load this preset's recipe.
                  setPromptText(promptForPreset(s));
                }}
                className={[
                  "flex flex-col items-center gap-1.5 rounded-md border px-2 pb-1.5 pt-2 transition-colors",
                  presetsExpanded ? "" : "w-[96px] shrink-0",
                  s.id === styleId && !refPath
                    ? "border-[rgb(var(--accent-color))] bg-[rgb(var(--accent-color)/0.08)]"
                    : "border-border/60 bg-app hover:border-border hover:bg-hover",
                ].join(" ")}
              >
                <span className="flex h-9 w-full items-center justify-center overflow-hidden">
                  <img src={s.thumb} alt="" className="max-h-full max-w-full object-contain" />
                </span>
                <span className="w-full truncate text-center text-[10px] leading-none text-muted">
                  {t(`handwriting.styles.${s.id}`)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Reference image — overrides the preset grid when set */}
        <div className="flex items-center gap-2">
          {refPath ? (
            <>
              <span
                className="flex h-10 w-16 items-center justify-center overflow-hidden rounded-md border border-border/60"
                style={{ background: "#ffffff" }}
              >
                <img src={mediaUrlFor(refPath)} alt="" className="max-h-full max-w-full object-contain" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                {t("handwriting.referenceActive")}
              </span>
              <button
                type="button"
                onClick={() => setRefPath(null)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
                title={t("handwriting.referenceClear")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={pickReference}
              className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border/70 bg-app px-2.5 text-[11px] text-muted transition-colors hover:border-border hover:bg-hover hover:text-text"
              data-testid="handwriting-pick-ref"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {t("handwriting.referencePick")}
            </button>
          )}
        </div>

        {/* Prompt — the single source of truth for what gets sent. Presets and
            the reference picker fill it; the user edits or replaces it freely
            (e.g. pasting a shared 口令). */}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">
            {t("handwriting.customPrompt")}
          </div>
          <textarea
            className="w-full resize-none rounded-md border border-border/70 bg-app px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none placeholder:text-muted2 hover:border-border focus:border-accent/50"
            rows={4}
            value={promptText}
            placeholder={t("handwriting.customPromptPlaceholder")}
            onChange={(e) => setPromptText(e.target.value)}
            data-testid="handwriting-custom-prompt"
          />
          {Boolean(text.trim()) && Boolean(promptText.trim()) && !needsText && (
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-amber-400/90">
              <span>{t("handwriting.missingTextWarn")}</span>
              <button
                type="button"
                onClick={() =>
                  setPromptText((p) =>
                    p.trimEnd() + (isCjkText(text) ? "书写内容：「{text}」。" : ' Write the words: "{text}".')
                  )
                }
                className="shrink-0 rounded border border-amber-400/40 px-1.5 py-0.5 text-amber-400/90 transition-colors hover:bg-amber-400/10"
              >
                {t("handwriting.insertText")}
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <select
            className={`${FIELD} min-w-0 flex-1`}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            data-testid="handwriting-provider-select"
          >
            {providers.length === 0 && (
              <option value="" disabled>{t("handwriting.noProviders")}</option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className={`${FIELD} min-w-0 flex-1`} value={model} onChange={(e) => setModel(e.target.value)}>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        {(providers.length === 0 || providerConfigured === false) && (
          <div className="rounded-md border border-border/60 bg-app px-3 py-2 text-[11px] leading-relaxed text-muted">
            {t("handwriting.notConfigured")}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">
            {error}
          </div>
        )}

        {(candidate || generating) && (
          <div
            ref={resultRef}
            className="flex min-h-[110px] items-center justify-center rounded-md border border-border/60 p-3"
            style={{ background: "#14161f" }}
          >
            {generating ? (
              <div className="flex items-center gap-2 text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-[11px]">{t("handwriting.generating")}</span>
              </div>
            ) : (
              <canvas
                ref={previewCanvasRef}
                className="max-h-32 max-w-full object-contain"
                data-testid="handwriting-candidate-0"
              />
            )}
          </div>
        )}

        {candidate && !generating && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">{t("handwriting.color")}</span>
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setFill((f) => ({ ...f, mode: "solid", color: c }))}
                className={[
                  "h-5 w-5 rounded-full border",
                  fill.mode === "solid" && c === fill.color
                    ? "border-[rgb(var(--accent-color))]"
                    : "border-border/60",
                ].join(" ")}
                style={{ background: c }}
              />
            ))}
            {/* Solid + gradient editor — same popover as the text fill */}
            <button
              ref={fillSwatchRef}
              type="button"
              onClick={() => setColorPickerOpen((v) => !v)}
              className={[
                "h-5 w-5 rounded-full border",
                fill.mode === "gradient" ? "border-[rgb(var(--accent-color))]" : "border-border/60",
              ].join(" ")}
              style={{
                background:
                  fill.mode === "gradient"
                    ? `linear-gradient(90deg, ${fill.gradient.from}, ${fill.gradient.to})`
                    : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
              }}
            />
            {colorPickerOpen && (
              <ColorPickerPopover
                anchorEl={fillSwatchRef.current}
                onClose={() => setColorPickerOpen(false)}
                presets={COLOR_SWATCHES}
                availableModes={["solid", "gradient"]}
                mode={fill.mode}
                onModeChange={(m) => setFill((f) => ({ ...f, mode: m }))}
                color={fill.color}
                onChange={(c) => setFill((f) => ({ ...f, mode: "solid", color: c }))}
                opacity={(fill.opacity ?? 100) / 100}
                onOpacityChange={(o) => setFill((f) => ({ ...f, opacity: Math.round(o * 100) }))}
                gradient={fill.gradient}
                onGradientChange={(g) => setFill((f) => ({ ...f, mode: "gradient", gradient: { ...f.gradient, ...g } }))}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
        <button
          type="button"
          onClick={generate}
          disabled={!canGenerate}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-app px-3 text-[12px] text-text transition-colors hover:border-border hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
          data-testid="handwriting-generate"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {candidate ? t("handwriting.regenerate") : t("handwriting.generate")}
        </button>
        <button
          type="button"
          onClick={addToCanvas}
          disabled={!candidate || generating}
          className="flex h-8 items-center rounded-md bg-[rgb(var(--accent-color))] px-3 text-[12px] font-medium text-black transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          data-testid="handwriting-add"
        >
          {t("handwriting.add")}
        </button>
      </div>
    </Modal>
  );
}
