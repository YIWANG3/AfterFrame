// AI tab — Auto-annotation. Multiple saved provider configs; one is active.
// Each provider is { id, name, type, baseUrl?, model } and the API key is
// stored separately, namespaced by the provider's id.
//
// Settings shape:
//   settings.aiAnnotation = {
//     providers: [...], activeProviderId,
//     languages, autoOnImport, maxTags, maxCaptionChars, customInstructions
//   }

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, AlertCircle, RefreshCw, Plus, Pencil, Trash2, Brain } from "lucide-react";
import {
  Group, FieldRow, Toggle, TextInput, NumberInput, Select,
  Chip, SecondaryButton, PrimaryButton, Callout,
} from "./SettingsPrimitives";

const PROVIDER_TYPES = [
  {
    label: "First-party APIs",
    options: [
      { value: "anthropic", label: "Anthropic (Claude)" },
      { value: "openai", label: "OpenAI (GPT-4o)" },
      { value: "google", label: "Google (Gemini)" },
    ],
  },
  {
    label: "Other (OpenAI-compatible)",
    options: [
      { value: "ollama", label: "Ollama (local)" },
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

  if (!settings) return <div className="text-[12px] text-muted">Loading settings…</div>;

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
    if (!confirm(`Delete provider "${provider.name || provider.type}"?`)) return;
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
        title="Auto-annotation providers"
        badge="New"
        subtitle="Save multiple provider configurations; switch between them with a click. The active one is used when you annotate assets."
      >
        {editing ? (
          <ProviderEditor
            initial={editing.provider}
            mode={editing.mode}
            onCancel={cancelEdit}
            onSave={saveProvider}
          />
        ) : (
          <>
            {settings.providers.length === 0 ? (
              <div className="px-1 py-6 text-center text-[11px] text-muted2">
                No providers yet. Add one to enable annotation.
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
              <button
                type="button"
                onClick={startAdd}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-app py-2 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
              >
                <Plus className="h-3 w-3" /> Add new provider
              </button>
            </div>
          </>
        )}
      </Group>

      <Group
        title="Annotation behavior"
        subtitle="Settings below apply to whichever provider is active when you annotate."
      >
        <FieldRow
          label="Auto-annotate on import"
          hint="Off by default. When on, every imported asset is annotated as part of the import pipeline."
        >
          <Toggle on={settings.autoOnImport} onChange={(v) => persist({ autoOnImport: v })} />
        </FieldRow>

        <FieldRow
          label="Tag languages"
          hint="Both selected means each photo gets tags in both languages, so search hits across users."
        >
          <Chip on={settings.languages.includes("en")} onClick={() => toggleLang("en")}>English</Chip>
          <Chip on={settings.languages.includes("zh")} onClick={() => toggleLang("zh")}>中文</Chip>
        </FieldRow>

        <FieldRow
          label="Max tags per image"
          hint="Hard cap. The model sees this and trims its own output."
        >
          <NumberInput value={settings.maxTags} min={1} max={50} onChange={(v) => persist({ maxTags: v })} />
        </FieldRow>

        <FieldRow
          label="Max description length"
          hint="Characters. Short captions read better in the inspector and search."
        >
          <NumberInput
            value={settings.maxCaptionChars}
            min={40}
            max={1000}
            step={10}
            onChange={(v) => persist({ maxCaptionChars: v })}
            suffix="chars"
          />
        </FieldRow>

        <FieldRow
          label="Custom instructions"
          hint={'Appended to every prompt. Use this to bias toward your taste — e.g. "prefer style and mood tags over generic objects".'}
          stack
        >
          <textarea
            value={settings.customInstructions || ""}
            onChange={(e) => persist({ customInstructions: e.target.value })}
            rows={3}
            className="w-full resize-y rounded border border-border bg-app px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted2/60 focus:border-accent"
            placeholder="Optional…"
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
  return (
    <div
      className={[
        "mb-2 flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors last:mb-0",
        active ? "border-accent bg-accent/5" : "border-border bg-app hover:bg-hover/40",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onActivate}
        title={active ? "Active" : "Set as active"}
        className={[
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          active ? "border-accent" : "border-muted2 hover:border-text",
        ].join(" ")}
      >
        {active && <span className="h-2 w-2 rounded-full bg-accent" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium text-text">
            {provider.name || PROVIDER_TYPE_LABEL[provider.type] || provider.type}
          </span>
          {active && (
            <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-accent">
              Active
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
        <button
          type="button"
          onClick={onEdit}
          title="Edit"
          className="flex h-7 w-7 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="flex h-7 w-7 items-center justify-center rounded text-muted2 transition-colors hover:bg-error/15 hover:text-error"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/* ─── Provider editor (add + edit form) ──────────────────────────────── */

function ProviderEditor({ initial, mode, onCancel, onSave }) {
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
      setTestState({ ok: false, error: "Restart the app to pick up the new IPC handlers." });
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
      setTestState(result || { ok: false, error: "Sidecar returned an empty response." });
    } catch (e) {
      setTestState({ ok: false, error: e?.message || "Test failed" });
    }
  }

  async function handleFetchModels() {
    if (typeof window.mediaWorkspace?.listAnnotationModels !== "function") {
      setFetchModelsError("Restart the app to pick up the new IPC handlers.");
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
        setFetchModelsError(result?.error || "Failed to fetch models");
      }
    } catch (e) {
      setFetchModelsError(e?.message || "Failed to fetch models");
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
    <div className="py-3">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted2">
        {mode === "add" ? "New provider" : "Edit provider"}
      </div>

      <FieldRow label="Display name" hint="Short label shown in the provider list.">
        <TextInput
          value={draft.name}
          onChange={(v) => update({ name: v })}
          placeholder={providerLabel}
          className="w-[260px]"
        />
      </FieldRow>

      <FieldRow label="Type">
        <Select
          value={draft.type}
          onChange={(t) => update({
            type: t,
            baseUrl: DEFAULT_HOST_URL[t] || "",
            model: DEFAULT_MODEL[t] || "",
          })}
          options={PROVIDER_TYPES}
        />
      </FieldRow>

      {showHostUrl && (
        <FieldRow
          label="Host URL"
          hint={
            <>
              Full OpenAI-compatible base URL <strong className="text-text">including <code className="rounded bg-app px-1">/v1</code></strong>. Local Ollama is usually <code className="rounded bg-app px-1">http://localhost:11434/v1</code>.
            </>
          }
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
        label="API key"
        hint={isLocal ? "Leave empty for local-only providers like Ollama." : "Stored locally in your keychain. Never sent to AfterFrame servers."}
        stack
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            type="password"
            value={keyValue}
            onChange={(v) => { setKeyValue(v); }}
            monospace
            className="flex-1 min-w-0"
            placeholder={isLocal ? "(none for local)" : "sk-…"}
          />
          {keyConfigured && (keyValue.startsWith("•") || !keyValue) ? (
            <SecondaryButton onClick={handleClearKey}>Clear</SecondaryButton>
          ) : (
            <SecondaryButton onClick={handleSaveKey} disabled={keySaving || !keyValue || keyValue.startsWith("•")}>
              {keySaving ? "Saving…" : "Save key"}
            </SecondaryButton>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <SecondaryButton onClick={handleTest} disabled={testState === "running"}>
            {testState === "running" ? "Testing…" : "Test connection"}
          </SecondaryButton>
          {testState && testState !== "running" && (
            testState.ok ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-success">
                <Check className="h-3 w-3" /> {testState.info || "Reachable"}
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
        label="Model"
        hint={isLocal && fetchedModels.length === 0 ? "Type the model id or click ↻ to fetch the list from your endpoint." : null}
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
          title={fetchingModels ? "Fetching…" : (fetchedModels.length > 0 ? "Refresh model list" : "Fetch model list from endpoint")}
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
          <strong className="font-semibold text-accent">Where your images go</strong> — when you annotate, AfterFrame uploads a 512px-max-edge JPEG directly from your machine to <strong>{providerLabel}</strong>{isLocal ? "" : "'s API"}. We never proxy or store your photos. EXIF GPS is stripped from the upload.
        </Callout>
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={handleSubmit}>
          {mode === "add" ? "Add provider" : "Save changes"}
        </PrimaryButton>
      </div>
    </div>
  );
}
