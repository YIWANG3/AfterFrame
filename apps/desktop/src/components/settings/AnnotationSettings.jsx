// AI tab — Auto-annotation provider config. Stored under
// settings.aiAnnotation; key stored separately via setAnnotationKey
// (namespaced provider token).
//
// Provider taxonomy (matches mockup):
//   - First-party APIs: anthropic / openai / google
//   - Other (OpenAI-compatible): ollama / openai_compatible
// "Other" providers reveal a Host URL field.

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  Group, FieldRow, Toggle, TextInput, NumberInput, Select,
  Chip, SecondaryButton, Callout,
} from "./SettingsPrimitives";

const PROVIDER_OPTIONS = [
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

const MODELS_BY_PROVIDER = {
  anthropic: [
    { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5  (best quality)" },
    { value: "claude-haiku-4-5", label: "claude-haiku-4-5  (cheap)" },
  ],
  openai: [
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  ],
  google: [
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  ],
  ollama: [
    { value: "llava:latest", label: "llava:latest" },
    { value: "qwen2.5vl:latest", label: "qwen2.5vl:latest" },
  ],
  openai_compatible: [
    { value: "custom", label: "Custom model id (set below)" },
  ],
};

const DEFAULT_HOST_URL = {
  ollama: "http://localhost:11434/v1",
  openai_compatible: "https://",
};

const IS_LOCAL_OR_CUSTOM = (p) => p === "ollama" || p === "openai_compatible";

const DEFAULT_PROVIDER = "anthropic";

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama (local)",
  openai_compatible: "your custom endpoint",
};

export default function AnnotationSettings() {
  const [settings, setSettings] = useState(null);
  const [keyValue, setKeyValue] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyVerifying, setKeyVerifying] = useState(false);
  const [keyVerified, setKeyVerified] = useState(false);
  const [error, setError] = useState(null);

  // Load settings on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      if (cancelled) return;
      const provider = s.provider || DEFAULT_PROVIDER;
      setSettings({
        provider,
        model: s.model || MODELS_BY_PROVIDER[provider]?.[0]?.value || "",
        hostUrl: s.hostUrl || DEFAULT_HOST_URL[provider] || "",
        languages: Array.isArray(s.languages) && s.languages.length ? s.languages : ["en", "zh"],
        autoOnImport: !!s.autoOnImport,
        maxTags: Number.isFinite(s.maxTags) ? s.maxTags : 10,
        maxCaptionChars: Number.isFinite(s.maxCaptionChars) ? s.maxCaptionChars : 200,
        customInstructions: s.customInstructions || "",
      });
    })();
    return () => { cancelled = true; };
  }, []);

  // Load key for the selected provider
  useEffect(() => {
    if (!settings?.provider) return;
    let cancelled = false;
    (async () => {
      const cfg = (await window.mediaWorkspace?.getAnnotationKey?.(settings.provider)) || {};
      if (cancelled) return;
      setKeyConfigured(!!cfg.token);
      setKeyValue(cfg.token ? "•".repeat(20) : "");
      setKeyVerified(false);
      setError(null);
    })();
    return () => { cancelled = true; };
  }, [settings?.provider]);

  const update = useCallback(
    async (patch) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      await window.mediaWorkspace?.saveAnnotationSettings?.(patch);
    },
    [settings],
  );

  if (!settings) {
    return <div className="text-[12px] text-muted">Loading settings…</div>;
  }

  const isLocal = IS_LOCAL_OR_CUSTOM(settings.provider);
  const showHostUrl = isLocal;
  const providerLabel = PROVIDER_LABELS[settings.provider] || settings.provider;

  async function handleSaveKey() {
    if (!keyValue || keyValue.startsWith("•")) return;
    setKeyVerifying(true);
    setError(null);
    try {
      await window.mediaWorkspace?.setAnnotationKey?.(settings.provider, keyValue);
      setKeyConfigured(true);
      setKeyVerified(true);
      setKeyValue("•".repeat(20));
    } catch (e) {
      setError(e?.message || "Failed to save key");
    } finally {
      setKeyVerifying(false);
    }
  }

  async function handleClearKey() {
    await window.mediaWorkspace?.deleteAnnotationKey?.(settings.provider);
    setKeyConfigured(false);
    setKeyVerified(false);
    setKeyValue("");
  }

  function toggleLang(code) {
    const has = settings.languages.includes(code);
    const next = has ? settings.languages.filter((x) => x !== code) : [...settings.languages, code];
    if (next.length === 0) return; // require at least one
    update({ languages: next });
  }

  return (
    <div>
      <Group
        title="Auto-annotation"
        badge="New"
        subtitle="Generate captions, tags, and location guesses for your photos. Off until you add a key."
      >
        <FieldRow label="Provider">
          <Select
            value={settings.provider}
            onChange={(v) => {
              const nextModel = MODELS_BY_PROVIDER[v]?.[0]?.value || "";
              update({
                provider: v,
                model: nextModel,
                hostUrl: DEFAULT_HOST_URL[v] || "",
              });
            }}
            options={PROVIDER_OPTIONS}
          />
        </FieldRow>

        {showHostUrl && (
          <FieldRow
            label="Host URL"
            hint="OpenAI-compatible /v1 endpoint. Ollama defaults to localhost."
          >
            <TextInput
              value={settings.hostUrl || ""}
              onChange={(v) => update({ hostUrl: v })}
              monospace
              className="w-[280px]"
              placeholder="http://localhost:11434/v1"
            />
          </FieldRow>
        )}

        <FieldRow
          label="API key"
          hint={
            isLocal
              ? "Leave empty for local-only providers like Ollama."
              : "Stored locally in your keychain. Never sent to AfterFrame servers."
          }
          stack
        >
          <div className="flex items-center gap-1.5">
            <TextInput
              type="password"
              value={keyValue}
              onChange={(v) => { setKeyValue(v); setKeyVerified(false); }}
              monospace
              className="flex-1 min-w-0"
              placeholder={isLocal ? "(none for Ollama)" : "sk-…"}
            />
            {keyConfigured && !keyVerified ? (
              <SecondaryButton onClick={handleClearKey}>Clear</SecondaryButton>
            ) : null}
            {keyVerified ? (
              <span className="inline-flex h-7 items-center gap-1 rounded border border-success/30 bg-success/10 px-2 text-[11px] text-success">
                <Check className="h-3 w-3" /> Saved
              </span>
            ) : (
              <SecondaryButton onClick={handleSaveKey} disabled={keyVerifying || !keyValue || keyValue.startsWith("•")}>
                {keyVerifying ? "Saving…" : "Save"}
              </SecondaryButton>
            )}
          </div>
          {error && (
            <div className="mt-2 text-[11px] text-error">{error}</div>
          )}
          <div className="mt-2.5">
            <Callout>
              <strong className="font-semibold text-accent">Where your images go</strong> — when you trigger annotation, AfterFrame uploads a 512px-max-edge JPEG directly from your machine to <strong>{providerLabel}</strong>
              {isLocal ? " on your local network" : "'s API"}. We never proxy or store your photos. EXIF GPS is stripped from the upload. You can revoke the key any time above.
            </Callout>
          </div>
        </FieldRow>

        <FieldRow label="Model">
          <Select
            value={settings.model || ""}
            onChange={(v) => update({ model: v })}
            options={MODELS_BY_PROVIDER[settings.provider] || []}
          />
        </FieldRow>

        <FieldRow
          label="Auto-annotate on import"
          hint="Off by default. When on, every imported asset is annotated as part of the import pipeline."
        >
          <Toggle on={settings.autoOnImport} onChange={(v) => update({ autoOnImport: v })} />
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
          <NumberInput value={settings.maxTags} min={1} max={50} onChange={(v) => update({ maxTags: v })} />
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
            onChange={(v) => update({ maxCaptionChars: v })}
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
            onChange={(e) => update({ customInstructions: e.target.value })}
            rows={3}
            className="w-full resize-y rounded border border-border bg-app px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted2/60 focus:border-accent"
            placeholder="Optional…"
          />
        </FieldRow>
      </Group>

      <Group title="AI Repaint" subtitle="Image-to-image style transfer. Used by the AI Repaint tool in the editor.">
        <div className="py-6 text-center text-[11px] text-muted2">
          Configure AI Repaint providers from the editor's AI Repaint panel for now — migration to Settings coming soon.
        </div>
      </Group>
    </div>
  );
}
