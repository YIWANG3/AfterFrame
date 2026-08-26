// AI tab — Auto-annotation. Multiple saved provider configs; one is active.
// Each provider is { id, name, type, baseUrl?, model } and the API key is
// stored separately, namespaced by the provider's id.
//
// Settings shape:
//   settings.aiAnnotation = {
//     providers: [...], activeProviderId,
//     languages, autoOnImport, maxTags, maxCaptionChars, customInstructions
//   }

import api from "../../api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, AlertCircle, RefreshCw, Plus, Pencil, Trash2, Brain, X } from "lucide-react";
import { Button, Modal } from "../../ui";
import {
  Group, FieldRow, Toggle, TextInput, NumberInput, Select,
  Chip, SecondaryButton, Callout, ActiveRadio, IconActionButton,
} from "./SettingsPrimitives";

// Ollama has no dedicated entry — "Custom endpoint…" covers it (it is just an
// OpenAI-compatible base URL). Existing ollama-typed providers keep working
// via the lookup tables below. OpenAI is desktop-only: api.openai.com sends
// no CORS headers, so the web build's direct fetch can never reach it.
const PROVIDER_TYPES = [
  {
    label: "First-party APIs",
    options: [
      { value: "anthropic", label: "Anthropic (Claude)" },
      { value: "openai", label: "OpenAI", desktopOnly: true },
      { value: "google", label: "Google (Gemini)" },
    ],
  },
  {
    label: "Other (OpenAI-compatible)",
    options: [
      { value: "openai_compatible", label: "Custom endpoint…" },
    ],
  },
];

const PROVIDER_TYPE_LABEL = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  openai_compatible: "Custom",
};

const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
  ollama: "llava:latest",
  openai_compatible: "",
};

const DEFAULT_HOST_URL = {
  // Gemini's OpenAI-compatible endpoint (CORS-enabled) — the google type is
  // sent through the openai_compatible adapter and needs this base URL.
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434/v1",
  openai_compatible: "",
};

const IS_LOCAL_OR_CUSTOM = (t) => t === "ollama" || t === "openai_compatible";

// Provider types supported by the sidecar adapters. Google is in the UI
// for future-proofing but currently sent through openai_compatible.
const SIDECAR_PROVIDER = (t) => {
  if (t === "anthropic") return "anthropic";
  if (t === "openai" || t === "openai_compatible" || t === "ollama") return "openai_compatible";
  return "openai_compatible";
};

function newProviderTemplate(type = "anthropic") {
  return {
    id: crypto.randomUUID(),
    name: "",
    type,
    baseUrl: DEFAULT_HOST_URL[type] || "",
    model: DEFAULT_MODEL[type] || "",
  };
}

function defaultSettings() {
  return {
    providers: [],
    activeProviderId: null,
    languages: ["en", "zh"],
    autoOnImport: false,
    maxTags: 10,
    maxCaptionChars: 200,
    videoFrameInterval: 0,
    maxWorkers: 3,
    customInstructions: "",
  };
}

function hydrate(stored) {
  const next = { ...defaultSettings(), ...(stored || {}) };
  next.providers = Array.isArray(stored?.providers) ? stored.providers : [];
  next.languages = Array.isArray(stored?.languages) && stored.languages.length ? stored.languages : ["en", "zh"];

  // One-time migration from the old single-provider shape. The stored API
  // key was namespaced by provider TYPE, so we keep the id == type to
  // preserve the key without forcing a re-paste.
  if (next.providers.length === 0 && stored?.provider) {
    const id = stored.provider;
    next.providers = [
      {
        id,
        name: PROVIDER_TYPE_LABEL[stored.provider] || stored.provider,
        type: stored.provider,
        baseUrl: stored.hostUrl || DEFAULT_HOST_URL[stored.provider] || "",
        model: stored.model || DEFAULT_MODEL[stored.provider] || "",
      },
    ];
    next.activeProviderId = id;
  }

  return next;
}

export default function AnnotationSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(null); // { provider, mode: "add" | "edit" }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      if (cancelled) return;
      setSettings(hydrate(stored));
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = useCallback(async (patch) => {
    setSettings((curr) => {
      const next = { ...curr, ...patch };
      // Broadcast so live UI (e.g. AnnotationsSection's enabled state) updates
      // without waiting for a remount or window focus. Carry the resolved
      // hasProvider in the event so the store doesn't re-read settings and
      // race this not-yet-flushed write.
      const hasProvider = Array.isArray(next.providers) && next.providers.length > 0;
      void (async () => {
        try {
          await window.mediaWorkspace?.saveAnnotationSettings?.(next);
        } finally {
          window.dispatchEvent(
            new CustomEvent("annotation-settings:changed", { detail: { hasProvider } }),
          );
        }
      })();
      return next;
    });
  }, []);

  if (!settings) return <div className="text-[12px] text-muted">{t("annotation.loading")}</div>;

  function startAdd() {
    setEditing({ provider: newProviderTemplate(), mode: "add" });
  }
  function startEdit(provider) {
    setEditing({ provider: { ...provider }, mode: "edit" });
  }
  function cancelEdit() {
    setEditing(null);
  }
  async function saveProvider(provider) {
    const isFirst = settings.providers.length === 0;
    const existingIdx = settings.providers.findIndex((p) => p.id === provider.id);
    const nextProviders = existingIdx >= 0
      ? settings.providers.map((p) => (p.id === provider.id ? provider : p))
      : [...settings.providers, provider];
    await persist({
      providers: nextProviders,
      activeProviderId: isFirst ? provider.id : (settings.activeProviderId || provider.id),
    });
    setEditing(null);
  }
  async function deleteProvider(provider) {
    if (!confirm(t("annotation.deleteConfirm", { name: provider.name || provider.type }))) return;
    const next = settings.providers.filter((p) => p.id !== provider.id);
    const nextActive = settings.activeProviderId === provider.id
      ? (next[0]?.id || null)
      : settings.activeProviderId;
    await persist({ providers: next, activeProviderId: nextActive });
    try { await window.mediaWorkspace?.deleteAnnotationKey?.(provider.id); } catch {}
  }
  async function setActive(provider) {
    await persist({ activeProviderId: provider.id });
  }

  return (
    <div>
      <Group
        title={t("annotation.providersTitle")}
        subtitle={t("annotation.providersSubtitle")}
      >
        {settings.providers.length === 0 ? (
          <div className="px-1 py-6 text-center text-[11px] text-muted2">
            {t("annotation.noProviders")}
          </div>
        ) : (
          <div className="py-3">
            {settings.providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                active={settings.activeProviderId === p.id}
                onActivate={() => setActive(p)}
                onEdit={() => startEdit(p)}
                onDelete={() => deleteProvider(p)}
              />
            ))}
          </div>
        )}
        <div className="py-3">
          <SecondaryButton onClick={startAdd}>
            <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" /> {t("annotation.addNewProvider")}</span>
          </SecondaryButton>
        </div>
      </Group>

      {editing && (
        <ProviderEditor
          initial={editing.provider}
          mode={editing.mode}
          onCancel={cancelEdit}
          onSave={saveProvider}
        />
      )}

      <Group
        title={t("annotation.behaviorTitle")}
        subtitle={t("annotation.behaviorSubtitle")}
      >
        <FieldRow
          label={t("annotation.autoOnImport")}
          hint={t("annotation.autoOnImportHint")}
        >
          <Toggle on={settings.autoOnImport} onChange={(v) => persist({ autoOnImport: v })} />
        </FieldRow>

        <FieldRow
          label={t("annotation.tagLanguages")}
          hint={t("annotation.tagLanguagesHint")}
        >
          <Chip on={settings.languages.includes("en")} onClick={() => toggleLang("en")}>English</Chip>
          <Chip on={settings.languages.includes("zh")} onClick={() => toggleLang("zh")}>中文</Chip>
        </FieldRow>

        <FieldRow
          label={t("annotation.maxTags")}
          hint={t("annotation.maxTagsHint")}
        >
          <NumberInput value={settings.maxTags} min={1} max={50} onChange={(v) => persist({ maxTags: v })} />
        </FieldRow>

        <FieldRow
          label={t("annotation.maxDescLength")}
          hint={t("annotation.maxDescLengthHint")}
        >
          <NumberInput
            value={settings.maxCaptionChars}
            min={40}
            max={1000}
            step={10}
            onChange={(v) => persist({ maxCaptionChars: v })}
            suffix={t("annotation.chars")}
          />
        </FieldRow>

        <FieldRow
          label={t("annotation.videoFrameInterval")}
          hint={t("annotation.videoFrameIntervalHint")}
        >
          <NumberInput
            value={settings.videoFrameInterval}
            min={0}
            max={3600}
            step={10}
            onChange={(v) => persist({ videoFrameInterval: v })}
            suffix={t("annotation.seconds")}
          />
        </FieldRow>

        <FieldRow
          label={t("annotation.maxWorkers")}
          hint={t("annotation.maxWorkersHint")}
        >
          <NumberInput
            value={settings.maxWorkers}
            min={1}
            max={16}
            onChange={(v) => persist({ maxWorkers: v })}
          />
        </FieldRow>

        <FieldRow
          label={t("annotation.customInstructions")}
          hint={t("annotation.customInstructionsHint")}
          stack
        >
          <textarea
            value={settings.customInstructions || ""}
            onChange={(e) => persist({ customInstructions: e.target.value })}
            rows={3}
            className="w-full resize-y rounded border border-border bg-app px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted2/60 focus:border-accent"
            placeholder={t("annotation.optional")}
          />
        </FieldRow>
      </Group>

    </div>
  );

  function toggleLang(code) {
    const has = settings.languages.includes(code);
    const next = has ? settings.languages.filter((x) => x !== code) : [...settings.languages, code];
    if (next.length === 0) return;
    persist({ languages: next });
  }
}

/* ─── Provider row in the list ───────────────────────────────────────── */

function ProviderRow({ provider, active, onActivate, onEdit, onDelete }) {
  const { t } = useTranslation("settings");
  return (
    <div
      className={[
        "mb-1.5 flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors last:mb-0",
        active ? "border-accent/40 bg-accent/5" : "border-border/50 bg-panel2 hover:bg-hover/40",
      ].join(" ")}
    >
      <ActiveRadio
        active={active}
        onClick={onActivate}
        title={active ? t("annotation.active") : t("annotation.setActive")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium text-text">
            {provider.name || PROVIDER_TYPE_LABEL[provider.type] || provider.type}
          </span>
          {active && (
            <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-accent">
              {t("providers.active")}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted2">
          {PROVIDER_TYPE_LABEL[provider.type] || provider.type}
          {provider.model ? ` · ${provider.model}` : ""}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconActionButton
          onClick={onEdit}
          title={t("annotation.edit")}
        >
          <Pencil className="h-3 w-3" />
        </IconActionButton>
        <IconActionButton
          onClick={onDelete}
          title={t("annotation.delete")}
          danger
        >
          <Trash2 className="h-3 w-3" />
        </IconActionButton>
      </div>
    </div>
  );
}

/* ─── Provider editor (add + edit form) ──────────────────────────────── */

function ProviderEditor({ initial, mode, onCancel, onSave }) {
  const { t } = useTranslation("settings");
  const localizedProviderTypes = useMemo(() => PROVIDER_TYPES.map((g) => ({
    ...g,
    label: g.label === "First-party APIs" ? t("annotation.typeGroupFirstParty")
      : g.label === "Other (OpenAI-compatible)" ? t("annotation.typeGroupOther")
      : g.label,
    options: g.options
      .filter((o) => !o.desktopOnly || !api.capabilities.web)
      .map((o) => (o.value === "openai_compatible"
        ? { ...o, label: t("annotation.typeCustomEndpoint") }
        : o)),
  })), [t]);
  const [draft, setDraft] = useState(initial);
  const [keyValue, setKeyValue] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [testState, setTestState] = useState(null);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState(null);

  // Load existing key for this provider id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = (await window.mediaWorkspace?.getAnnotationKey?.(draft.id)) || {};
      if (cancelled) return;
      setKeyConfigured(!!cfg.token);
      setKeyValue(cfg.token ? "•".repeat(20) : "");
    })();
    return () => { cancelled = true; };
  }, [draft.id]);

  function update(patch) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  const isLocal = IS_LOCAL_OR_CUSTOM(draft.type);
  const showHostUrl = isLocal;

  async function handleSaveKey() {
    if (!keyValue || keyValue.startsWith("•")) return;
    setKeySaving(true);
    try {
      await window.mediaWorkspace?.setAnnotationKey?.(draft.id, keyValue);
      setKeyConfigured(true);
      setKeyValue("•".repeat(20));
    } finally {
      setKeySaving(false);
    }
  }

  async function handleClearKey() {
    await window.mediaWorkspace?.deleteAnnotationKey?.(draft.id);
    setKeyConfigured(false);
    setKeyValue("");
  }

  async function handleTest() {
    if (typeof window.mediaWorkspace?.testAnnotationConnection !== "function") {
      setTestState({ ok: false, error: t("annotation.restartHandlers") });
      return;
    }
    setTestState("running");
    try {
      const result = await window.mediaWorkspace.testAnnotationConnection({
        providerId: draft.id,
        provider: SIDECAR_PROVIDER(draft.type),
        apiKey: keyValue && !keyValue.startsWith("•") ? keyValue : null,
        baseUrl: draft.baseUrl || null,
      });
      setTestState(result || { ok: false, error: t("annotation.emptyResponse") });
    } catch (e) {
      setTestState({ ok: false, error: e?.message || t("annotation.testFailed") });
    }
  }

  async function handleFetchModels() {
    if (typeof window.mediaWorkspace?.listAnnotationModels !== "function") {
      setFetchModelsError(t("annotation.restartHandlers"));
      return;
    }
    setFetchingModels(true);
    setFetchModelsError(null);
    try {
      const result = await window.mediaWorkspace.listAnnotationModels({
        providerId: draft.id,
        provider: SIDECAR_PROVIDER(draft.type),
        apiKey: keyValue && !keyValue.startsWith("•") ? keyValue : null,
        baseUrl: draft.baseUrl || null,
      });
      if (result?.ok && Array.isArray(result.models)) {
        setFetchedModels(result.models);
        if (result.models.length > 0 && !result.models.some((m) => m.id === draft.model)) {
          update({ model: result.models[0].id });
        }
      } else {
        setFetchModelsError(result?.error || t("annotation.fetchModelsFailed"));
      }
    } catch (e) {
      setFetchModelsError(e?.message || t("annotation.fetchModelsFailed"));
    } finally {
      setFetchingModels(false);
    }
  }

  function handleSubmit() {
    const cleaned = {
      ...draft,
      name: (draft.name || "").trim() || PROVIDER_TYPE_LABEL[draft.type] || draft.type,
    };
    onSave(cleaned);
  }

  const providerLabel = PROVIDER_TYPE_LABEL[draft.type] || draft.type;

  return (
    <Modal onClose={onCancel} z="overlayTop" className="max-w-[560px]">
      <div className="max-h-[80vh] overflow-y-auto px-4 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">
            {mode === "add" ? t("annotation.newProvider") : t("annotation.editProvider")}
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={onCancel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

      <FieldRow label={t("annotation.displayName")} hint={t("annotation.displayNameHint")}>
        <TextInput
          value={draft.name}
          onChange={(v) => update({ name: v })}
          placeholder={providerLabel}
          className="w-[260px]"
        />
      </FieldRow>

      <FieldRow label={t("annotation.type")}>
        <Select
          value={draft.type}
          onChange={(nextType) => update({
            type: nextType,
            baseUrl: DEFAULT_HOST_URL[nextType] || "",
            model: DEFAULT_MODEL[nextType] || "",
          })}
          options={localizedProviderTypes}
        />
      </FieldRow>

      {showHostUrl && (
        <FieldRow
          label={t("annotation.hostUrl")}
          hint={t("annotation.hostUrlHint")}
        >
          <TextInput
            value={draft.baseUrl || ""}
            onChange={(v) => update({ baseUrl: v })}
            monospace
            className="w-[280px]"
            placeholder="http://localhost:11434/v1"
          />
        </FieldRow>
      )}

      <FieldRow
        label={t("annotation.apiKey")}
        hint={isLocal ? t("annotation.apiKeyHintLocal") : t("annotation.apiKeyHint")}
        stack
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            type="password"
            value={keyValue}
            onChange={(v) => { setKeyValue(v); }}
            monospace
            className="flex-1 min-w-0"
            placeholder={isLocal ? t("annotation.noneForLocal") : "sk-…"}
          />
          {keyConfigured && (keyValue.startsWith("•") || !keyValue) ? (
            <SecondaryButton onClick={handleClearKey}>{t("annotation.clear")}</SecondaryButton>
          ) : (
            <SecondaryButton onClick={handleSaveKey} disabled={keySaving || !keyValue || keyValue.startsWith("•")}>
              {keySaving ? t("annotation.saving") : t("annotation.saveKey")}
            </SecondaryButton>
          )}
        </div>
        {api.capabilities.web && (
          <div className="mt-2 text-[11px] leading-snug text-muted2">
            {t("desktop.byokNotice", { ns: "common" })}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <SecondaryButton onClick={handleTest} disabled={testState === "running"}>
            {testState === "running" ? t("annotation.testing") : t("annotation.testConnection")}
          </SecondaryButton>
          {testState && testState !== "running" && (
            testState.ok ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-success">
                <Check className="h-3 w-3" /> {testState.info || t("annotation.reachable")}
              </span>
            ) : (
              <span className="inline-flex max-w-[400px] items-center gap-1 text-[11px] text-error">
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span className="truncate" title={testState.error}>{testState.error}</span>
              </span>
            )
          )}
        </div>
      </FieldRow>

      <FieldRow
        label={t("annotation.model")}
        hint={isLocal && fetchedModels.length === 0 ? t("annotation.modelHintLocal") : null}
      >
        {fetchedModels.length > 0 ? (
          <Select
            value={draft.model || ""}
            onChange={(v) => update({ model: v })}
            options={fetchedModels.map((m) => ({ value: m.id, label: m.label }))}
          />
        ) : (
          <TextInput
            value={draft.model || ""}
            onChange={(v) => update({ model: v })}
            monospace
            className="w-[260px]"
            placeholder={DEFAULT_MODEL[draft.type] || "model-id"}
          />
        )}
        <button
          type="button"
          onClick={handleFetchModels}
          disabled={fetchingModels}
          title={fetchingModels ? t("annotation.fetching") : (fetchedModels.length > 0 ? t("annotation.refreshModelList") : t("annotation.fetchModelList"))}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-app text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${fetchingModels ? "animate-spin" : ""}`} />
        </button>
      </FieldRow>
      {fetchModelsError && (
        <div className="-mt-1 pb-2 text-[11px] text-error">{fetchModelsError}</div>
      )}

      <div className="mt-2">
        <Callout>
          <strong className="font-semibold text-accent">{t("annotation.calloutTitle")}</strong>{t("annotation.calloutBody", { provider: providerLabel })}
        </Callout>
      </div>

      </div>

      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
        <Button variant="primary" onClick={handleSubmit}>
          {mode === "add" ? t("annotation.addProvider") : t("annotation.saveChanges")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>{t("annotation.cancel")}</Button>
      </div>
    </Modal>
  );
}
