import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  Check,
  ChevronDown,
  Columns2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Rows2,
  Sparkles,
  StretchHorizontal,
  Trash2,
  X,
} from "lucide-react";

/* ── Provider type templates (not instances) ── */
const PROVIDER_TYPES = [
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
    label: "即梦 (Jimeng)",
    capability: "Image generation & editing",
    authFields: ["access_key_id", "secret_access_key"],
    placeholders: { access_key_id: "Access Key ID", secret_access_key: "Secret Access Key" },
    defaultModels: [
      { id: "jimeng_t2i_v40", name: "即梦 图片生成 4.0" },
      { id: "jimeng_seedream46_cvtob", name: "即梦 图片生成 4.6" },
      { id: "jimeng_i2i_seed3_tilesr_cvtob", name: "即梦 智能超清" },
    ],
  },
];

function getProviderType(typeKey) {
  return PROVIDER_TYPES.find((t) => t.type === typeKey) || null;
}

function generateInstanceId() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function generateInstanceName(typeKey, existingInstances) {
  const tmpl = getProviderType(typeKey);
  const base = tmpl?.label || typeKey;
  const sameType = existingInstances.filter((p) => p.type === typeKey);
  if (sameType.length === 0) return base;
  return `${base} ${sameType.length + 1}`;
}

/* ── Merge instance data with its type template ── */
function enrichInstance(inst) {
  const tmpl = getProviderType(inst.type);
  if (!tmpl) return { ...inst, label: inst.name, defaultModels: [] };
  return {
    ...tmpl,
    ...inst,
    label: inst.name,
  };
}

/* ── Old key → type mapping for migration ── */
const LEGACY_KEY_TO_TYPE = {
  nanobanana: "nanobanana",
  openai: "openai",
  openai_compatible: "openai_compatible",
  jimeng: "jimeng",
};

const ASPECT_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

const RESOLUTION_OPTIONS = [
  { value: "1k", label: "1K" },
  { value: "2k", label: "2K" },
  { value: "4k", label: "4K" },
];

const INITIAL_STYLES = [
  { id: "classical-oil", name: "Classical Oil Painting", prompt: "Transform this photo into a classical oil painting style. Strictly preserve the original composition, perspective, subject placement, and scene layout. Do not add or remove major elements, and do not change the camera angle. Preserve the real architectural or human structure and the original lighting direction. Emphasize rigorous perspective, balanced composition, sculptural volume, restrained and sophisticated color relationships, and fine oil-paint texture. The final image should feel solemn, rational, harmonious, and classically refined. Avoid modern digital illustration aesthetics, exaggerated anime stylization, and excessive fantasy effects." },
  { id: "baroque", name: "Baroque Dramatic Lighting", prompt: "Transform this photo into a Baroque oil painting style. Strictly preserve the main subject and spatial relationships. Preserve the original scene structure while emphasizing strong chiaroscuro, spotlight-like dramatic illumination, deep shadows, rich material density, and narrative tension. The overall mood should feel solemn, intense, and theatrical, like a Baroque master painting. Avoid cartoon stylization, flat high-saturation rendering, and modern photo-editing aesthetics." },
  { id: "academic-realist", name: "Academic Realist Oil Painting", prompt: "Transform this photo into a 19th-century academic painting style. Strictly preserve realistic proportions, facial structure, and architectural form. Emphasize highly finished details, smooth and precise tonal transitions, refined material rendering, and elegant, restrained color harmony. The final image should resemble a museum-quality academic portrait or landscape painting. Avoid rough painterly treatment, comic-style linework, or concept-art shortcuts." },
  { id: "impressionist", name: "Impressionist Light and Color", prompt: "Transform this photo into an Impressionist painting style. Strictly preserve the original composition and subject layout. Keep the original lighting logic and major forms, but soften overly sharp photographic detail. Emphasize visible brushwork, luminous atmosphere, the movement of light across buildings, trees, and water, and soft yet bright broken color. The final image should feel airy, poetic, and plein-air in spirit. Avoid photographic realism, overly thick paint, and harsh black outlines." },
  { id: "post-impressionist", name: "Post-Impressionist Structural Color", prompt: "Transform this photo into a Post-Impressionist painting style. Strictly preserve the main structure and spatial depth. Emphasize simplified color masses, rhythmic brushwork, slightly subjective warm-cool relationships, and a clearer sense of structural form. The result should feel like a classic painting that balances observation and design. Avoid pure abstraction, flat anime coloring, and excessive softness." },
  { id: "impasto", name: "Expressive Impasto Oil Painting", prompt: "Transform this photo into an expressive impasto oil painting style. Preserve the main composition and scene information while emphasizing directional brushwork, thick tactile paint buildup, more dynamic skies and clouds, and emotionally intensified color. The final image should feel energetic, vivid, and full of painterly life. Do not let it become abstract or lose subject readability." },
  { id: "symbolist", name: "Symbolist Dream Atmosphere", prompt: "Transform this photo into a Symbolist painting style. Strictly preserve the original composition and subject relationships. Keep the real spatial foundation, but enhance mysterious diffused light, poetic color, slightly surreal yet still tactile materials, and a quiet dreamlike atmosphere. The final image should feel like a poetic scene suspended between reality and vision. Avoid cyberpunk elements and high-contrast commercial poster aesthetics." },
  { id: "surrealism", name: "Surrealism", prompt: "Transform this photo into a Surrealist style. Strictly preserve the original structure and major elements, and do not introduce bizarre new objects. Let the image feel real in texture but unreal in mood: calm yet uncanny light, slightly dreamlike spatial logic, and crisp detail within an unfamiliar atmosphere. The final result should feel surreal but believable. Avoid humor, collage chaos, or cheap visual effects." },
  { id: "watercolor", name: "Transparent Watercolor", prompt: "Transform this photo into a refined transparent watercolor style. Preserve the original composition and major structure. Emphasize luminous layered washes, soft bleeding edges, paper texture, airy negative space, and gentle light. The result should feel bright, breathable, elegant, and like a highly finished travel watercolor painting. Avoid thick oil-paint texture, harsh outlines, and photographic realism." },
  { id: "gouache", name: "Matte Gouache Illustration", prompt: "Transform this photo into a gouache illustration style. Preserve the original structure and perspective. Emphasize matte surfaces, soft opaque color layering, clearly simplified forms, and gentle design-oriented color blocking. The final image should feel like a high-end editorial illustration or vintage travel poster. Avoid photo texture, excessive realistic reflections, and heavy oil-paint materiality." },
  { id: "editorial-illustration", name: "Modern Editorial Illustration", prompt: "Transform this photo into a modern editorial illustration style. Preserve the subject and spatial information. Emphasize simplified geometric color planes, clean edges, a small amount of hand-drawn texture, a strong visual focal point, and sophisticated magazine-illustration sensibility. The result should feel minimal, modern, restrained, and design-forward. Avoid children's-book aesthetics, overly cartoonish rendering, or excessive texture noise." },
  { id: "chinese-ink", name: "Chinese Ink Painting", prompt: "Transform this photo into a Chinese ink landscape painting style. Preserve the original layout of mountains, architecture, water, and trees, but reduce photographic detail. Emphasize ink tonal variation, negative space, mist, expressive brush texture, and layered spatial atmosphere. The final image should feel ethereal, restrained, and deeply rooted in East Asian landscape aesthetics. Avoid Western oil-lighting treatment and highly saturated commercial illustration color." },
  { id: "blue-green-landscape", name: "Blue-Green Landscape Painting", prompt: "Transform this photo into a classical blue-green landscape painting style. Preserve the original spatial structure while emphasizing mineral-like blue, green, and ochre tones, finely rendered mountain textures, and decorative mist treatment. The final image should feel elegant, ornate, and rooted in classical Eastern decorative painting. Avoid modern photographic realism and Western fantasy aesthetics." },
  { id: "ukiyo-e", name: "Ukiyo-e / Shin-Hanga", prompt: "Transform this photo into a style blending Ukiyo-e and Shin-Hanga. Preserve the original composition and landmark information. Emphasize crisp outlines, clean flat color planes, rhythmic linework, decorative composition, and woodblock-print color sensibility. The final image should feel elegant, flattened, and classically Japanese in visual character. Avoid photographic realism and thick Western painterly rendering." },
  { id: "vintage-poster", name: "Vintage Travel Poster", prompt: "Transform this photo into a vintage travel poster style with printmaking influence. Preserve the main architecture and terrain silhouette. Emphasize graphic silhouettes, broad color fields, a limited palette, subtle paper grain, and printed-poster character. The final image should feel like a premium mid-20th-century travel poster. Avoid modern 3D-render aesthetics and overly detailed photoreal materials." },
  { id: "anime-bg", name: "High-End Anime Background Art", prompt: "Transform this photo into a high-end anime background art style. Strictly preserve the original composition, perspective, architecture, and scene layout. Do not add or remove major elements, and do not change the camera angle. Preserve the real-world structural logic of buildings and streets while emphasizing clean hand-drawn linear guidance, luminous flat-painted color, natural lighting, beautifully volumetric clouds, and polished cinematic environment painting. The final image should feel like a background from a high-budget animated film. Avoid low-quality anime filter effects, chibi stylization, and cyberpunk neon overload." },
  { id: "anime-sky", name: "Cinematic Anime Sky", prompt: "Transform this photo into a cinematic anime scene style. Strictly preserve the original content and perspective while emphasizing luminous layered skies, sculptural clouds, rim light, reflections, atmospheric perspective, and emotionally precise color relationships. The image should feel like a key background frame from an animated film. Avoid rough brushwork and childlike illustration aesthetics." },
  { id: "anime-blue-hour", name: "Blue Hour Anime Background", prompt: "Transform this photo into a blue-hour anime background style. Preserve the original time-of-day atmosphere. Emphasize cool-warm sky transitions, subtle early city lights, reflections on glass and pavement, moisture in the air, and a quiet cinematic mood. Do not turn dusk into daylight, and avoid overly sugary color grading." },
  { id: "cel-shaded", name: "Clean Cel-Shaded Anime", prompt: "Transform this photo into a high-quality cel-shaded anime illustration style. Preserve the original subject and spatial relationships. Emphasize clean contours, simplified color planes, restrained cel shading, crisp highlights, and slight paper-like texture. The final image should feel fresh, light, and modern. Avoid heavy painterly rendering, excessive realistic skin texture, and photographic optical effects." },
  { id: "jp-magazine", name: "Japanese Magazine Cover", prompt: "Transform this photo into a Japanese magazine-cover illustration style. Preserve the original composition and theme. Emphasize elegant simplification of facial or architectural forms, restrained color design, soft shadows, and subtle editorial sophistication. The final image should feel refined, stylish, and lightly retro. Avoid children's-book visuals and game character key art aesthetics." },
  { id: "magical-realism", name: "Magical Realism", prompt: "Transform this photo into a magical realism style. Preserve the real-world architectural and lighting logic, and introduce wonder only through atmosphere: richer air layers, slightly uncanny yet believable color and light, and a tactile dreamlike mood. The final image should feel surreal but grounded, magical but tactile. Avoid obvious magical effects and excessive floating fantasy elements." },
  { id: "fantasy-env", name: "European Fantasy Environment", prompt: "Transform this photo into a high-quality fantasy environment painting style. Strictly preserve the original composition and scene structure, and do not add obvious new elements. Emphasize grand spatial scale, intricate architectural layering, epic clouds, world-building richness, and cinematic environment-painting polish. The final image should feel like premium fantasy concept art. Avoid plain photorealism and cyberpunk styling." },
  { id: "aaa-concept", name: "AAA Game Concept Art", prompt: "Transform this photo into AAA game environment concept art. Preserve the original content and landmark structure. Emphasize designed light organization, a clear focal hierarchy, layered material rendering, volumetric clouds, environmental storytelling, and a polished concept-art finish. The final image should feel immersive, believable, and grand in scale. Avoid low-detail matte-painting blur." },
  { id: "art-deco", name: "Art Deco", prompt: "Transform this photo into an Art Deco style. Strictly preserve the main subject and composition. Emphasize geometric silhouettes, elegant and luxurious color orchestration, streamlined but restrained decorative linework, poster-like compositional order, and urban sophistication. The final image should feel glamorous, modern, and refined. Avoid childish hand-drawn aesthetics and rough painterly treatment." },
  { id: "art-nouveau", name: "Art Nouveau", prompt: "Transform this photo into an Art Nouveau style. Preserve the original subject structure and composition. Emphasize organic curves, ornamental patterning, elegant contours, soft vintage color palettes, and decorative pictorial rhythm. The final image should feel refined, lyrical, and rich in poster-art elegance. Avoid modern cyber elements and overly aggressive geometric fragmentation." },
];

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

const TOOLBAR_FIELD =
  "h-8 w-full rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none hover:border-border focus:border-accent/50";
const TOOLBAR_BUTTON =
  "inline-flex h-8 items-center justify-center rounded-md border border-border/70 bg-app px-3 py-0 text-[12px] font-medium text-text transition-colors hover:border-border hover:bg-hover";
const ACCENT_BUTTON =
  "inline-flex h-8 items-center justify-center rounded-md bg-[rgb(var(--accent-color))] px-3 py-0 text-[12px] font-medium text-black transition-colors hover:brightness-110";

function PanelLabel({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{children}</div>;
}

function CollapsibleSection({ label, collapsed, onToggle, border = "border-b", className, children, trailing }) {
  return (
    <div className={cx(border, "border-border/60", className)}>
      <div className="flex w-full items-center gap-2 px-4 py-3">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={onToggle}
        >
          <ChevronDown className={cx("h-3 w-3 text-muted2 transition-transform", collapsed && "-rotate-90")} />
          <PanelLabel>{label}</PanelLabel>
        </button>
        {trailing && <div className="ml-auto">{trailing}</div>}
      </div>
      {!collapsed && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

function StyleCard({ style, active, onSelect, onEdit, onDelete }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cx(
        "w-full rounded-lg border px-3 py-3 text-left transition-colors",
        active
          ? "border-[rgb(var(--accent-color)/0.38)] bg-[rgb(var(--accent-color)/0.10)]"
          : "border-border/60 bg-app hover:border-border hover:bg-hover/60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text">{style.name}</div>
          <div className="mt-1 truncate pr-1 text-[11px] leading-5 text-muted">{style.prompt}</div>
        </div>
        <div className="ml-2 flex shrink-0 items-start gap-1">
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
            title="Edit style"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            title="Delete style"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function StyleRow({ style, active, onSelect, onEdit, onDelete }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cx(
        "group flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
        active
          ? "bg-selected text-text"
          : "text-muted hover:bg-hover/70 hover:text-text",
      )}
    >
      <span className="truncate text-[12px]">{style.name}</span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          className="rounded-md p-0.5 text-muted2 transition-colors hover:text-text"
          onClick={(event) => { event.stopPropagation(); onEdit(); }}
          title="Edit style"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="rounded-md p-0.5 text-muted2 transition-colors hover:text-text"
          onClick={(event) => { event.stopPropagation(); onDelete(); }}
          title="Delete style"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}

function EditStyleModal({ title, draft, onChange, onSave, onClose }) {
  return (
    <div className="fixed inset-0 z-[10210] flex items-center justify-center bg-black/45 px-5 backdrop-blur-[2px]">
      <div className="w-full max-w-[360px] overflow-hidden rounded-xl border border-border/60 bg-chrome shadow-overlay">
        <div className="px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <PanelLabel>{title}</PanelLabel>
            <button
              type="button"
              className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="Style name"
            className={`mt-3 ${TOOLBAR_FIELD} placeholder:text-muted2`}
            autoFocus
          />
          <textarea
            value={draft.prompt}
            onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
            placeholder="Prompt"
            className="mt-2 min-h-[96px] w-full rounded-md border border-border/70 bg-app px-2 py-2 text-[12px] leading-5 text-text outline-none placeholder:text-muted2 hover:border-border focus:border-accent/50"
          />
        </div>
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <button type="button" className={ACCENT_BUTTON} onClick={onSave}>
            Save style
          </button>
          <button type="button" className={TOOLBAR_BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Provider instance modal: create new / edit existing ── */
function ProviderModal({
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
    <div className="fixed inset-0 z-[10210] flex items-center justify-center bg-black/45 px-5 backdrop-blur-[2px]">
      <div className="w-full max-w-[380px] overflow-hidden rounded-xl border border-border/60 bg-chrome shadow-overlay">
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
                className={TOOLBAR_FIELD}
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
              className={`${TOOLBAR_FIELD} placeholder:text-muted2`}
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
          <button type="button" className={ACCENT_BUTTON} onClick={handleSave}>
            {mode === "new" ? "Create" : "Save"}
          </button>
          {mode === "edit" && (
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-rose-500/30 bg-app px-3 py-0 text-[12px] font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10"
              onClick={() => onDelete(instance.id)}
            >
              Delete
            </button>
          )}
          <button type="button" className={TOOLBAR_BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AiRepaintPanel({ sourcePath, sourceLabel = "Current image", onCompareChange, compareState, onRepaintComplete }) {
  const repaintPollRef = useRef(null);
  const prefsRef = useRef({});
  const [providerInstances, setProviderInstances] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [providerConfigs, setProviderConfigs] = useState({});
  const [styles, setStyles] = useState(null);
  const [selectedStyleId, setSelectedStyleId] = useState(null);
  const [providerModalState, setProviderModalState] = useState(null); // null | { mode: "new" } | { mode: "edit", instanceId: string }
  const [editingStyleId, setEditingStyleId] = useState(null);
  const [styleDraft, setStyleDraft] = useState({ name: "", prompt: "" });
  const [temperature, setTemperature] = useState(1);
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [resolution, setResolution] = useState("4k");
  const [customPrompt, setCustomPrompt] = useState("");
  const [compactStyles, setCompactStyles] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState(new Set());
  const [generateStatus, setGenerateStatus] = useState({ running: false, status: null, error: null });
  const [results, setResults] = useState([]);
  const [repaintHistory, setRepaintHistory] = useState([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [availableModels, setAvailableModels] = useState({});
  const [selectedModel, setSelectedModel] = useState({});

  // Derived: active instance enriched with type info
  const activeInstance = useMemo(
    () => {
      const inst = providerInstances.find((p) => p.id === activeProviderId);
      return inst ? enrichInstance(inst) : null;
    },
    [providerInstances, activeProviderId],
  );
  const selectedStyle = useMemo(
    () => styles?.find((entry) => entry.id === selectedStyleId) || null,
    [styles, selectedStyleId],
  );
  const providerConfigured = Boolean(activeProviderId && providerConfigs[activeProviderId]?.token);
  const activeModelId = activeProviderId ? selectedModel[activeProviderId] : null;
  const isUpscaleModel = activeModelId === "jimeng_i2i_seed3_tilesr_cvtob";

  function persistPrefs(patch) {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    void window.mediaWorkspace?.saveAiPreferences?.(next);
  }

  function persistInstances(nextInstances) {
    // Save instance metadata (without tokens) to preferences
    const stripped = nextInstances.map(({ id, type, name }) => ({ id, type, name }));
    persistPrefs({ providers: stripped });
  }

  function updateActiveProvider(providerId) {
    setActiveProviderId(providerId);
    persistPrefs({ activeProvider: providerId });
  }

  function updateSelectedModel(providerId, modelId) {
    setSelectedModel((current) => ({ ...current, [providerId]: modelId }));
    persistPrefs({ selectedModels: { ...prefsRef.current.selectedModels, [providerId]: modelId } });
  }

  async function fetchModels(providerId, providerType, tokenValue) {
    const models = await window.mediaWorkspace?.listAiModels?.(providerId, providerType);
    if (Array.isArray(models) && models.length) {
      setAvailableModels((current) => ({ ...current, [providerId]: models }));
      persistPrefs({ modelsCache: { ...prefsRef.current.modelsCache, [providerId]: models } });
      setSelectedModel((current) => {
        if (current[providerId] && models.some((m) => m.id === current[providerId])) return current;
        const fallback = models[0].id;
        persistPrefs({ selectedModels: { ...prefsRef.current.selectedModels, [providerId]: fallback } });
        return { ...current, [providerId]: fallback };
      });
    }
  }

  /* ── Migration: convert old per-key configs to instances ── */
  async function migrateOldProviders(prefs) {
    if (prefs.providers?.length) return prefs.providers; // already migrated

    const oldKeys = Object.keys(LEGACY_KEY_TO_TYPE);
    const payloads = await Promise.all(
      oldKeys.map((key) =>
        window.mediaWorkspace?.getAiProviderToken?.(key).then((r) => ({ key, ...r })).catch(() => ({ key })),
      ),
    );

    const migrated = [];
    for (const payload of payloads) {
      if (!payload?.token) continue;
      const typeKey = LEGACY_KEY_TO_TYPE[payload.key];
      const tmpl = getProviderType(typeKey);
      const inst = {
        id: `p_migrated_${payload.key}`,
        type: typeKey,
        name: tmpl?.label || payload.key,
      };
      migrated.push(inst);
      // Copy token under new instance id
      await window.mediaWorkspace?.setAiProviderToken?.(inst.id, payload.token);
    }

    if (migrated.length) {
      // Remap activeProvider from old key to new instance id
      const oldActive = prefs.activeProvider;
      let newActive = null;
      if (oldActive) {
        const mapped = migrated.find((m) => m.id === `p_migrated_${oldActive}`);
        if (mapped) newActive = mapped.id;
      }
      // Remap selectedModels and modelsCache from old keys to new instance ids
      const remapObj = (obj) => {
        if (!obj) return {};
        const result = {};
        for (const [key, val] of Object.entries(obj)) {
          const mapped = migrated.find((m) => m.id === `p_migrated_${key}`);
          if (mapped) result[mapped.id] = val;
          else result[key] = val; // keep unmapped as-is
        }
        return result;
      };
      persistPrefs({
        providers: migrated.map(({ id, type, name }) => ({ id, type, name })),
        activeProvider: newActive || migrated[0]?.id || null,
        selectedModels: remapObj(prefs.selectedModels),
        modelsCache: remapObj(prefs.modelsCache),
      });
      return migrated;
    }
    return [];
  }

  useEffect(() => {
    async function loadStored() {
      // Load prefs and styles in parallel — styles first so migration can't interfere
      const [prefs, savedStyles] = await Promise.all([
        window.mediaWorkspace?.getAiPreferences?.().then((p) => p || {}),
        window.mediaWorkspace?.getAiStyles?.(),
      ]);
      prefsRef.current = prefs;

      // Apply styles immediately (before any migration)
      if (Array.isArray(savedStyles) && savedStyles.length) {
        setStyles(savedStyles);
        setSelectedStyleId((current) => {
          if (current && savedStyles.some((s) => s.id === current)) return current;
          return savedStyles[0]?.id ?? null;
        });
      } else {
        setStyles(INITIAL_STYLES);
        setSelectedStyleId(INITIAL_STYLES[0]?.id ?? null);
        persistStyles(INITIAL_STYLES);
      }

      // Migrate or load instances
      let instances = prefs.providers?.length
        ? prefs.providers
        : await migrateOldProviders(prefs);

      setProviderInstances(instances);

      // Reload prefs after migration may have changed them
      const freshPrefs = (await window.mediaWorkspace?.getAiPreferences?.()) || prefs;
      prefsRef.current = freshPrefs;

      if (freshPrefs.activeProvider) setActiveProviderId(freshPrefs.activeProvider);
      else if (instances.length) setActiveProviderId(instances[0].id);

      if (freshPrefs.selectedModels) setSelectedModel((cur) => ({ ...cur, ...freshPrefs.selectedModels }));
      if (freshPrefs.modelsCache) setAvailableModels((cur) => ({ ...cur, ...freshPrefs.modelsCache }));

      // Initialize default models for instances without cache
      for (const inst of instances) {
        const tmpl = getProviderType(inst.type);
        if (tmpl?.defaultModels?.length) {
          setAvailableModels((cur) => {
            if (cur[inst.id]?.length) return cur;
            return { ...cur, [inst.id]: tmpl.defaultModels };
          });
          setSelectedModel((cur) => {
            if (cur[inst.id]) return cur;
            return { ...cur, [inst.id]: tmpl.defaultModels[0].id };
          });
        }
      }

      // Load tokens and fetch models for configured instances
      for (const inst of instances) {
        const payload = await window.mediaWorkspace?.getAiProviderToken?.(inst.id);
        if (payload?.token) {
          setProviderConfigs((current) => ({ ...current, [inst.id]: payload }));
          fetchModels(inst.id, inst.type);
        }
      }
    }
    void loadStored();
    return () => {
      if (repaintPollRef.current) {
        clearInterval(repaintPollRef.current);
        repaintPollRef.current = null;
      }
    };
  }, []);

  function toggleSection(key) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  useEffect(() => {
    if (!sourcePath) return;
    void (async () => {
      const history = await window.mediaWorkspace?.listRepaintHistory?.(sourcePath);
      if (Array.isArray(history)) setRepaintHistory(history);
    })();
  }, [sourcePath]);

  function refreshHistory() {
    if (!sourcePath) return;
    void (async () => {
      const history = await window.mediaWorkspace?.listRepaintHistory?.(sourcePath);
      if (Array.isArray(history)) setRepaintHistory(history);
    })();
  }

  function persistStyles(nextStyles) {
    void window.mediaWorkspace?.saveAiStyles?.(nextStyles);
  }

  function resetDraft() {
    setEditingStyleId(null);
    setStyleDraft({ name: "", prompt: "" });
  }

  function openCreateStyle() {
    setEditingStyleId("new");
    setStyleDraft({ name: "", prompt: "" });
  }

  function openEditStyle(style) {
    setEditingStyleId(style.id);
    setStyleDraft({ name: style.name, prompt: style.prompt });
  }

  function saveStyleDraft() {
    const name = styleDraft.name.trim();
    const prompt = styleDraft.prompt.trim();
    if (!name || !prompt) return;

    if (editingStyleId && editingStyleId !== "new") {
      setStyles((current) => {
        const next = current.map((entry) => (entry.id === editingStyleId ? { ...entry, name, prompt } : entry));
        persistStyles(next);
        return next;
      });
      setSelectedStyleId(editingStyleId);
    } else {
      const nextId = `style-${Date.now()}`;
      setStyles((current) => {
        const next = [...current, { id: nextId, name, prompt }];
        persistStyles(next);
        return next;
      });
      setSelectedStyleId(nextId);
    }
    resetDraft();
  }

  function deleteStyle(styleId) {
    setStyles((current) => {
      const next = current.filter((entry) => entry.id !== styleId);
      persistStyles(next);
      setSelectedStyleId((selected) => (selected === styleId ? next[0]?.id ?? null : selected));
      return next;
    });
    if (editingStyleId === styleId) resetDraft();
  }

  /* ── Provider instance CRUD ── */
  function handleSaveProvider(inst, tokenValue) {
    setProviderInstances((current) => {
      const exists = current.some((p) => p.id === inst.id);
      const next = exists
        ? current.map((p) => (p.id === inst.id ? { id: inst.id, type: inst.type, name: inst.name } : p))
        : [...current, { id: inst.id, type: inst.type, name: inst.name }];
      persistInstances(next);
      return next;
    });

    // Save token
    if (tokenValue) {
      void (async () => {
        const payload = await window.mediaWorkspace?.setAiProviderToken?.(inst.id, tokenValue);
        setProviderConfigs((current) => ({
          ...current,
          [inst.id]: payload?.token ? payload : { token: tokenValue },
        }));
        fetchModels(inst.id, inst.type);
      })();
    }

    // Initialize default models
    const tmpl = getProviderType(inst.type);
    if (tmpl?.defaultModels?.length) {
      setAvailableModels((cur) => {
        if (cur[inst.id]?.length) return cur;
        return { ...cur, [inst.id]: tmpl.defaultModels };
      });
      setSelectedModel((cur) => {
        if (cur[inst.id]) return cur;
        return { ...cur, [inst.id]: tmpl.defaultModels[0].id };
      });
    }

    updateActiveProvider(inst.id);
    setProviderModalState(null);
  }

  function handleDeleteProvider(instanceId) {
    setProviderInstances((current) => {
      const next = current.filter((p) => p.id !== instanceId);
      persistInstances(next);
      return next;
    });
    void window.mediaWorkspace?.deleteAiProviderToken?.(instanceId);
    setProviderConfigs((current) => {
      const next = { ...current };
      delete next[instanceId];
      return next;
    });
    setActiveProviderId((current) => {
      if (current === instanceId) {
        const remaining = providerInstances.filter((p) => p.id !== instanceId);
        const next = remaining[0]?.id || null;
        persistPrefs({ activeProvider: next });
        return next;
      }
      return current;
    });
    setProviderModalState(null);
  }

  function queueApply() {
    const effectivePrompt = customPrompt.trim() || selectedStyle?.prompt;
    if (!isUpscaleModel && !effectivePrompt) return;
    if (!providerConfigured) {
      if (providerInstances.length === 0) {
        setProviderModalState({ mode: "new" });
      } else {
        setProviderModalState({ mode: "edit", instanceId: activeProviderId });
      }
      return;
    }
    if (!sourcePath) return;
    void (async () => {
      const inst = providerInstances.find((p) => p.id === activeProviderId);
      const task = await window.mediaWorkspace?.startAiRepaint?.({
        provider: activeProviderId,
        providerType: inst?.type || "nanobanana",
        sourcePath,
        prompt: isUpscaleModel ? "" : effectivePrompt,
        aspectRatio: aspectRatio === "auto" ? null : aspectRatio,
        resolution,
        temperature,
        model: selectedModel[activeProviderId] || null,
      });
      setGenerateStatus({
        running: Boolean(task?.running),
        status: task?.status || null,
        error: task?.error || null,
      });
    })();
  }

  useEffect(() => {
    if (!generateStatus.running) {
      if (repaintPollRef.current) {
        clearInterval(repaintPollRef.current);
        repaintPollRef.current = null;
      }
      return undefined;
    }
    repaintPollRef.current = window.setInterval(async () => {
      const task = await window.mediaWorkspace?.getAiRepaintStatus?.();
      setGenerateStatus({
        running: Boolean(task?.running),
        status: task?.status || null,
        error: task?.error || null,
      });
      if (!task?.running && repaintPollRef.current) {
        clearInterval(repaintPollRef.current);
        repaintPollRef.current = null;
        const outputPath = task?.result?.output_path;
        if (task?.status === "succeeded" && outputPath) {
          setResults((prev) => [
            { path: outputPath, timestamp: Date.now(), prompt: task.result.prompt || "" },
            ...prev,
          ]);
          onRepaintComplete?.();
          refreshHistory();
        }
      }
    }, 1500);
    return () => {
      if (repaintPollRef.current) {
        clearInterval(repaintPollRef.current);
        repaintPollRef.current = null;
      }
    };
  }, [generateStatus.running]);

  const editingInstance = providerModalState?.mode === "edit"
    ? providerInstances.find((p) => p.id === providerModalState.instanceId) || null
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <CollapsibleSection label="Provider" collapsed={collapsedSections.has("provider")} onToggle={() => toggleSection("provider")}>
          <div className="flex items-center gap-2">
            <select
              value={activeProviderId || ""}
              onChange={(event) => updateActiveProvider(event.target.value)}
              className={`min-w-0 flex-1 ${TOOLBAR_FIELD}`}
            >
              {providerInstances.length === 0 && (
                <option value="" disabled>No providers configured</option>
              )}
              {providerInstances.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{providerConfigs[p.id]?.token ? "" : " (no key)"}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-app text-text transition-colors hover:border-border hover:bg-hover"
              onClick={() => setProviderModalState({ mode: "new" })}
              title="Add provider"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            {activeProviderId && (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-app text-text transition-colors hover:border-border hover:bg-hover"
                onClick={() => setProviderModalState({ mode: "edit", instanceId: activeProviderId })}
                title="Edit provider"
              >
                <KeyRound className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {activeInstance && (
            <div className="mt-2">
              <div className="text-[11px] text-muted">Model</div>
              <select
                value={selectedModel[activeProviderId] || ""}
                onChange={(event) => updateSelectedModel(activeProviderId, event.target.value)}
                className={`mt-1 ${TOOLBAR_FIELD}`}
              >
                {(availableModels[activeProviderId] || []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection label="Parameters" collapsed={collapsedSections.has("parameters")} onToggle={() => toggleSection("parameters")}>
          <div className={cx(isUpscaleModel && "opacity-40 pointer-events-none")}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] text-text">Temperature</div>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={temperature}
                disabled={isUpscaleModel}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isNaN(next)) return;
                  setTemperature(Math.max(0, Math.min(1, next)));
                }}
                className="h-8 w-16 rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none hover:border-border focus:border-accent/50"
              />
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={temperature}
              disabled={isUpscaleModel}
              onChange={(event) => setTemperature(Number(event.target.value))}
              className="mt-3 w-full"
              aria-label="Temperature"
            />
          </div>

          <div className={cx("mt-4", isUpscaleModel && "opacity-40 pointer-events-none")}>
            <div className="text-[12px] text-text">Aspect ratio</div>
            <select
              value={aspectRatio}
              disabled={isUpscaleModel}
              onChange={(event) => setAspectRatio(event.target.value)}
              className={`mt-2 ${TOOLBAR_FIELD}`}
            >
              {ASPECT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4">
            <div className="text-[12px] text-text">Resolution</div>
            <select
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              className={`mt-2 ${TOOLBAR_FIELD}`}
            >
              {RESOLUTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          label="My Styles"
          collapsed={collapsedSections.has("styles")}
          onToggle={() => toggleSection("styles")}
          className={isUpscaleModel ? "opacity-40 pointer-events-none" : undefined}
          trailing={
            /* eslint-disable-next-line jsx-a11y/click-events-have-key-events */
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded transition-colors",
                  compactStyles ? "text-muted2 hover:bg-hover hover:text-text" : "bg-hover text-text",
                )}
                onClick={() => setCompactStyles(false)}
                title="Expanded view"
              >
                <StretchHorizontal className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded transition-colors",
                  compactStyles ? "bg-hover text-text" : "text-muted2 hover:bg-hover hover:text-text",
                )}
                onClick={() => setCompactStyles(true)}
                title="Compact view"
              >
                <AlignJustify className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded border border-border/70 bg-app text-text transition-colors hover:border-border hover:bg-hover"
                onClick={openCreateStyle}
                title="New style"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          }
        >
          <div className="mb-3">
            <div className="relative">
              <textarea
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="Enter a one-time prompt..."
                rows={2}
                className="w-full resize-none rounded-md border border-border/70 bg-app px-2.5 py-2 text-[12px] leading-5 text-text outline-none placeholder:text-muted2 hover:border-border focus:border-accent/50"
              />
              {customPrompt.trim() && (
                <button
                  type="button"
                  className="mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
                  onClick={() => {
                    setEditingStyleId("new");
                    setStyleDraft({ name: "", prompt: customPrompt.trim() });
                  }}
                  title="Save as style"
                >
                  <Plus className="h-3 w-3" />
                  Save as style
                </button>
              )}
            </div>
          </div>
          <div className={cx("max-h-[200px] overflow-y-auto", compactStyles ? "space-y-0.5" : "space-y-2")}>
            {!styles ? (
              <div className="flex items-center gap-2 py-4 text-[11px] text-muted2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading styles…
              </div>
            ) : styles.map((style) => compactStyles ? (
              <StyleRow
                key={style.id}
                style={style}
                active={selectedStyleId === style.id}
                onSelect={() => setSelectedStyleId(style.id)}
                onEdit={() => openEditStyle(style)}
                onDelete={() => deleteStyle(style.id)}
              />
            ) : (
              <StyleCard
                key={style.id}
                style={style}
                active={selectedStyleId === style.id}
                onSelect={() => setSelectedStyleId(style.id)}
                onEdit={() => openEditStyle(style)}
                onDelete={() => deleteStyle(style.id)}
              />
            ))}
          </div>
        </CollapsibleSection>

        {results.length > 0 ? (
          <CollapsibleSection label="Results" border="border-t" collapsed={collapsedSections.has("results")} onToggle={() => toggleSection("results")}>
            <div className="space-y-1">
              {results.map((r) => {
                const name = r.path.split("/").pop();
                const isComparing = compareState?.afterPath === r.path;
                return (
                  <div
                    key={r.path}
                    className={cx(
                      "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors",
                      isComparing ? "bg-[rgb(var(--accent-color)/0.12)] text-[rgb(var(--accent-color))]" : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate" title={r.path}>{name}</span>
                    <button
                      type="button"
                      className={cx(
                        "flex h-5 w-5 items-center justify-center rounded transition-colors",
                        isComparing
                          ? "text-[rgb(var(--accent-color))]"
                          : "text-muted2 opacity-0 group-hover:opacity-100 hover:text-text",
                      )}
                      onClick={() => {
                        if (isComparing) {
                          onCompareChange?.(null);
                        } else {
                          onCompareChange?.({ afterPath: r.path, layout: compareState?.layout || "side" });
                        }
                      }}
                      title={isComparing ? "Exit compare" : "Compare side-by-side"}
                    >
                      <Columns2 className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className={cx(
                        "flex h-5 w-5 items-center justify-center rounded transition-colors",
                        isComparing && compareState?.layout === "stack"
                          ? "text-[rgb(var(--accent-color))]"
                          : "text-muted2 opacity-0 group-hover:opacity-100 hover:text-text",
                      )}
                      onClick={() => {
                        if (isComparing && compareState?.layout === "stack") {
                          onCompareChange?.(null);
                        } else {
                          onCompareChange?.({ afterPath: r.path, layout: "stack" });
                        }
                      }}
                      title="Compare top/bottom"
                    >
                      <Rows2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        ) : null}

        {repaintHistory.length > 0 ? (
          <CollapsibleSection label="Versions" border="border-t" collapsed={collapsedSections.has("versions")} onToggle={() => toggleSection("versions")}>
            <div className="space-y-0.5">
              {repaintHistory.map((h) => {
                const name = h.output_path.split("/").pop();
                const isComparing = compareState?.afterPath === h.output_path;
                const isExpanded = expandedHistoryId === h.asset_id;
                return (
                  <div key={h.asset_id}>
                    <div
                      className={cx(
                        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors",
                        isComparing ? "bg-[rgb(var(--accent-color)/0.12)] text-[rgb(var(--accent-color))]" : "text-muted hover:bg-hover hover:text-text",
                      )}
                    >
                      <button
                        type="button"
                        className="flex h-4 w-4 shrink-0 items-center justify-center text-muted2"
                        onClick={() => setExpandedHistoryId(isExpanded ? null : h.asset_id)}
                      >
                        <ChevronDown className={cx("h-3 w-3 transition-transform", !isExpanded && "-rotate-90")} />
                      </button>
                      <span className="min-w-0 flex-1 truncate" title={h.output_path}>{name}</span>
                      <button
                        type="button"
                        className={cx(
                          "flex h-5 w-5 items-center justify-center rounded transition-colors",
                          isComparing && compareState?.layout !== "stack"
                            ? "text-[rgb(var(--accent-color))]"
                            : "text-muted2 opacity-0 group-hover:opacity-100 hover:text-text",
                        )}
                        onClick={() => {
                          if (isComparing && compareState?.layout !== "stack") {
                            onCompareChange?.(null);
                          } else {
                            onCompareChange?.({ afterPath: h.output_path, layout: "side" });
                          }
                        }}
                        title="Compare side-by-side"
                      >
                        <Columns2 className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className={cx(
                          "flex h-5 w-5 items-center justify-center rounded transition-colors",
                          isComparing && compareState?.layout === "stack"
                            ? "text-[rgb(var(--accent-color))]"
                            : "text-muted2 opacity-0 group-hover:opacity-100 hover:text-text",
                        )}
                        onClick={() => {
                          if (isComparing && compareState?.layout === "stack") {
                            onCompareChange?.(null);
                          } else {
                            onCompareChange?.({ afterPath: h.output_path, layout: "stack" });
                          }
                        }}
                        title="Compare top/bottom"
                      >
                        <Rows2 className="h-3 w-3" />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="ml-6 mt-1 mb-1.5 space-y-1 rounded-md bg-app px-2.5 py-2 text-[11px] leading-5 text-muted">
                        {h.prompt && <div><span className="text-muted2">Prompt: </span><span className="text-text">{h.prompt}</span></div>}
                        {h.provider && <div><span className="text-muted2">Provider: </span>{h.provider}{h.model ? ` / ${h.model}` : ""}</div>}
                        {h.temperature != null && <div><span className="text-muted2">Temperature: </span>{h.temperature}</div>}
                        {h.resolution && <div><span className="text-muted2">Resolution: </span>{h.resolution}</div>}
                        {h.aspect_ratio && <div><span className="text-muted2">Aspect ratio: </span>{h.aspect_ratio}</div>}
                        {h.created_at && <div><span className="text-muted2">Created: </span>{new Date(h.created_at + "Z").toLocaleString()}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        ) : null}

      </div>

      <div className="shrink-0 border-t border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex-1" />
          <button
            type="button"
            className={cx(
              "inline-flex h-8 items-center justify-center rounded-md px-3 py-0 text-[12px] font-medium transition-colors",
              generateStatus.running
                ? "ai-generating-btn text-black"
                : providerConfigured && (isUpscaleModel || selectedStyle || customPrompt.trim())
                  ? "bg-[rgb(var(--accent-color))] text-black hover:brightness-110"
                  : "bg-[rgb(var(--accent-color)/0.18)] text-[rgb(var(--accent-color))]",
            )}
            disabled={generateStatus.running}
            onClick={queueApply}
          >
            <span className="inline-flex items-center gap-1.5">
              {generateStatus.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : providerConfigured && (isUpscaleModel || selectedStyle || customPrompt.trim()) ? <Check className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
              {generateStatus.running ? "Generating…" : "Generate"}
            </span>
          </button>
        </div>
        {generateStatus.error ? (
          <div
            className="mt-1.5 line-clamp-2 cursor-default text-[11px] leading-4 text-rose-300/80"
            title={generateStatus.error}
          >
            {generateStatus.error}
          </div>
        ) : null}
      </div>

      {editingStyleId ? (
        <EditStyleModal
          title={editingStyleId === "new" ? "New Style" : "Edit Style"}
          draft={styleDraft}
          onChange={setStyleDraft}
          onSave={saveStyleDraft}
          onClose={resetDraft}
        />
      ) : null}

      {providerModalState ? (
        <ProviderModal
          mode={providerModalState.mode}
          instances={providerInstances}
          instance={editingInstance}
          onSave={handleSaveProvider}
          onDelete={handleDeleteProvider}
          onClose={() => setProviderModalState(null)}
        />
      ) : null}
    </div>
  );
}
