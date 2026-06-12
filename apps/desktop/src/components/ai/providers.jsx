/* AI provider registry + the create/edit credentials modal.
   Shared by the editor's AiRepaintPanel and Settings → AI Repaint —
   extracted so the settings tab no longer imports the whole editor panel. */

import { useEffect, useMemo, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { Modal, Button, cx } from "../../ui";

const FIELD =
  "h-8 w-full rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none hover:border-border focus:border-accent/50";

function PanelLabel({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{children}</div>;
}

export const PROVIDER_TYPES = [
  {
    type: "nanobanana",
    label: "Nanobanana",
    capability: "Image repaint",
    placeholder: "nb_live_xxx...",
    defaultModels: [
      { id: "gemini-2.0-flash-exp-image-generation", name: "Gemini 2.0 Flash (Image)" },
      { id: "gemini-2.0-flash-preview-image-generation", name: "Gemini 2.0 Flash Preview" },
      { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro (Image)" },
      { id: "gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash (Image)" },
    ],
  },
  {
    type: "openai",
    label: "OpenAI (GPT Image)",
    capability: "Image edit & repaint",
    placeholder: "sk-xxx...",
    defaultModels: [
      { id: "gpt-image-1", name: "GPT Image 1" },
    ],
  },
  {
    type: "openai_compatible",
    label: "OpenAI Compatible",
    capability: "Custom OpenAI-compatible endpoint",
    placeholder: "sk-xxx...",
    authFields: ["base_url", "token"],
    placeholders: { base_url: "https://your-server.com/v1", token: "API Key" },
    defaultModels: [
      { id: "gpt-image-1", name: "GPT Image 1" },
      { id: "gpt-image-2", name: "GPT Image 2" },
    ],
  },
  {
    type: "jimeng",
    label: "Jimeng",
    capability: "Image generation & editing",
    authFields: ["access_key_id", "secret_access_key"],
    placeholders: { access_key_id: "Access Key ID", secret_access_key: "Secret Access Key" },
    defaultModels: [
      { id: "jimeng_t2i_v40", name: "Jimeng Image 4.0" },
      { id: "jimeng_seedream46_cvtob", name: "Jimeng Image 4.6" },
      { id: "jimeng_i2i_seed3_tilesr_cvtob", name: "Jimeng Super Resolution" },
    ],
  },
];

export function getProviderType(typeKey) {
  return PROVIDER_TYPES.find((t) => t.type === typeKey) || null;
}

export function generateInstanceId() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function generateInstanceName(typeKey, existingInstances) {
  const tmpl = getProviderType(typeKey);
  const base = tmpl?.label || typeKey;
  const sameType = existingInstances.filter((p) => p.type === typeKey);
  if (sameType.length === 0) return base;
  return `${base} ${sameType.length + 1}`;
}

export function ProviderModal({
  mode,          // "new" | "edit"
  instances,     // all existing instances (for auto-naming)
  instance,      // existing instance when mode=edit, null for new
  onSave,        // (instance, tokenValue) => void
  onDelete,      // (instanceId) => void
  onClose,
}) {
  const [selectedType, setSelectedType] = useState(instance?.type || PROVIDER_TYPES[0].type);
  const [name, setName] = useState(
    instance?.name || (mode === "new" ? generateInstanceName(PROVIDER_TYPES[0].type, instances) : ""),
  );
  const [tokenValue, setTokenValue] = useState("");
  const [hasExistingToken, setHasExistingToken] = useState(false);

  // Load existing token when editing
  useEffect(() => {
    if (mode === "edit" && instance?.id) {
      void (async () => {
        const stored = await window.mediaWorkspace?.getAiProviderToken?.(instance.id);
        if (stored?.token) {
          setTokenValue(stored.token);
          setHasExistingToken(true);
        }
      })();
    }
  }, [mode, instance?.id]);

  // Auto-update name when type changes in new mode
  function handleTypeChange(nextType) {
    setSelectedType(nextType);
    if (mode === "new") {
      setName(generateInstanceName(nextType, instances));
    }
  }

  const tmpl = getProviderType(selectedType);
  const isMultiField = Boolean(tmpl?.authFields);

  const parsedFields = useMemo(() => {
    if (!isMultiField) return {};
    try { return JSON.parse(tokenValue || "{}"); } catch { return {}; }
  }, [tokenValue, isMultiField]);

  function updateField(fieldName, value) {
    const next = { ...parsedFields, [fieldName]: value };
    setTokenValue(JSON.stringify(next));
  }

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    // Validate credentials
    if (isMultiField) {
      try {
        const parsed = JSON.parse(tokenValue || "{}");
        if (tmpl.authFields.some((f) => !parsed[f]?.trim())) return;
      } catch { return; }
    } else {
      if (!tokenValue.trim() && !hasExistingToken) return;
    }

    const inst = mode === "edit"
      ? { ...instance, name: trimmedName }
      : { id: generateInstanceId(), type: selectedType, name: trimmedName };

    onSave(inst, tokenValue.trim() || null);
  }

  return (
    <Modal onClose={onClose} z="overlayTop">
      <div>
        <div className="px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <PanelLabel>{mode === "new" ? "New Provider" : "Edit Provider"}</PanelLabel>
            <button
              type="button"
              className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {mode === "new" && (
            <label className="mt-3 block">
              <div className="mb-1 text-[11px] text-muted">Type</div>
              <select
                value={selectedType}
                onChange={(e) => handleTypeChange(e.target.value)}
                className={FIELD}
              >
                {PROVIDER_TYPES.map((t) => (
                  <option key={t.type} value={t.type}>{t.label}</option>
                ))}
              </select>
            </label>
          )}

          {mode === "edit" && (
            <div className="mt-3 text-[11px] text-muted">
              Type: {tmpl?.label || instance?.type}
            </div>
          )}

          <label className="mt-3 block">
            <div className="mb-1 text-[11px] text-muted">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Provider name"
              className={cx(FIELD, "placeholder:text-muted2")}
              autoFocus={mode === "new"}
            />
          </label>

          <div className="mt-4">
            <PanelLabel>{isMultiField ? "Credentials" : "API Token"}</PanelLabel>
          </div>

          {isMultiField ? (
            <div className="mt-2 space-y-2">
              {tmpl.authFields.map((field) => (
                <div key={field} className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-app px-2 hover:border-border focus-within:border-accent/50">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted2" />
                  <input
                    value={parsedFields[field] || ""}
                    onChange={(e) => updateField(field, e.target.value)}
                    placeholder={tmpl.placeholders?.[field] || field}
                    className="h-full flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-muted2"
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 flex h-8 items-center gap-2 rounded-md border border-border/70 bg-app px-2 hover:border-border focus-within:border-accent/50">
              <KeyRound className="h-3.5 w-3.5 text-muted2" />
              <input
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder={tmpl?.placeholder || "API key..."}
                className="h-full flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-muted2"
              />
            </div>
          )}
          {hasExistingToken && !tokenValue.trim() && (
            <div className="mt-1 text-[11px] text-muted">Credentials saved (encrypted). Leave blank to keep existing.</div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <Button variant="primary" onClick={handleSave}>
            {mode === "new" ? "Create" : "Save"}
          </Button>
          {mode === "edit" && (
            <Button variant="danger" onClick={() => onDelete(instance.id)}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
