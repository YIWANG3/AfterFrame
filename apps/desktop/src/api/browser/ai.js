// AI repaint (Gemini direct fetch, sidecar ai_repaint.py semantics) and the
// AI settings store the repaint panel reads on mount. Preferences/styles
// persist in localStorage; provider keys are the BYOK tokens of state.js.

import { assets, jobStatus, persistTokens, sessionTokens } from "./state";
import { ingestFile } from "./files";
import { collectionMethods } from "./collections";
import { base64ToBlob, blobToBase64, randomHex } from "./llm";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-3-pro-image-preview";
const GEMINI_MODELS_WITH_IMAGE_SIZE = new Set(["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"]);

let repaintJob = null; // singleton, mirrors formatJobStatus fields the panel reads
// History rows survive reloads via asset ids (blob URLs are session-scoped).
const repaintHistory = [];

async function geminiGenerateImage({ apiKey, model, prompt, sourceBlob, aspectRatio, imageSize }) {
  const generationConfig = { responseModalities: ["TEXT", "IMAGE"] };
  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize && GEMINI_MODELS_WITH_IMAGE_SIZE.has(model)) imageConfig.imageSize = imageSize;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: sourceBlob.type || "image/jpeg", data: await blobToBase64(sourceBlob) } },
        ],
      }],
      generationConfig,
    }),
  });
  if (!res.ok) throw new Error(`Gemini request failed: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const payload = await res.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) return base64ToBlob(inline.data, inline.mimeType || inline.mime_type || "image/png");
  }
  throw new Error(`Gemini returned no image output: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function runRepaint(opts) {
  const providerConfig = sessionTokens.get(opts.provider);
  if (!providerConfig?.token) throw new Error("No API token configured for provider.");
  const source = assets.find((a) => a.image_path === opts.sourcePath)
    || assets.find((a) => a.asset_id === opts.sourcePath);
  const sourceBlob = await (await fetch(opts.sourcePath)).blob();
  const model = opts.model || DEFAULT_GEMINI_MODEL;
  const outputBlob = await geminiGenerateImage({
    apiKey: providerConfig.token,
    model,
    prompt: opts.prompt || "",
    sourceBlob,
    aspectRatio: opts.aspectRatio || null,
    imageSize: opts.resolution ? String(opts.resolution).toUpperCase() : null,
  });
  // Register the result as a catalog asset (the desktop registers it as an
  // ai_repaint version via the sidecar).
  const stem = source?.stem || "image";
  const name = `${stem}_ai-repaint_${randomHex(8)}.png`;
  const outputAsset = await ingestFile(new File([outputBlob], name, { type: outputBlob.type || "image/png" }));
  if (!outputAsset) throw new Error("Could not decode the generated image.");
  const now = new Date();
  const createdAt = now.toISOString().slice(0, 19).replace("T", " "); // panel appends "Z" itself
  const row = {
    repaint_id: `rp-${Date.now()}-${randomHex(4)}`,
    source_asset_id: source?.asset_id || null,
    output_asset_id: outputAsset.asset_id,
    prompt: opts.prompt || "",
    provider: opts.providerType || "nanobanana",
    model,
    temperature: opts.temperature ?? null,
    aspect_ratio: opts.aspectRatio || null,
    resolution: opts.resolution || null,
    created_at: createdAt,
  };
  repaintHistory.push(row);
  return { outputAsset, row };
}

const repaintStatus = () => (repaintJob ? jobStatus(repaintJob) : jobStatus());

export const aiMethods = {
  // ── AI settings store (consumed by AiRepaintPanel on mount) ──
  getAiPreferences: async () => {
    try { return JSON.parse(localStorage.getItem("afterframe.aiPrefs")) || {}; } catch { return {}; }
  },
  saveAiPreferences: async (prefs) => {
    localStorage.setItem("afterframe.aiPrefs", JSON.stringify(prefs || {}));
  },
  getAiStyles: async () => {
    try { return JSON.parse(localStorage.getItem("afterframe.aiStyles")); } catch { return null; }
  },
  saveAiStyles: async (styles) => {
    localStorage.setItem("afterframe.aiStyles", JSON.stringify(styles ?? null));
  },
  getAiProviderToken: async (id) => sessionTokens.get(id) || null,
  setAiProviderToken: async (id, token) => { sessionTokens.set(id, { token }); persistTokens(); return { token }; },
  deleteAiProviderToken: async (id) => { sessionTokens.delete(id); persistTokens(); },
  listAiModels: async (providerId) => {
    const key = sessionTokens.get(providerId)?.token;
    if (!key) return [];
    try {
      const res = await fetch(`${GEMINI_BASE}/models`, { headers: { "x-goog-api-key": key } });
      if (!res.ok) return [];
      const payload = await res.json();
      const seen = new Map();
      for (const m of payload.models || []) {
        const id = String(m.name || "").replace(/^models\//, "");
        if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
        if (!id.includes("image")) continue;
        const label = m.displayName || id;
        // Prefer non-preview ids per display name, like list_gemini_models.
        if (!seen.has(label) || (seen.get(label).id.includes("preview") && !id.includes("preview"))) {
          seen.set(label, { id, name: label });
        }
      }
      return [...seen.values()];
    } catch { return []; }
  },

  // ── AI repaint job (singleton, ai_repaint.py semantics) ──
  startAiRepaint: async (opts = {}) => {
    if (repaintJob?.running) return repaintStatus(); // mirror desktop: one at a time
    repaintJob = { running: true, active: true, status: "running", kind: "ai_repaint", error: null, result: null, startedAt: Date.now() };
    void (async () => {
      try {
        const { outputAsset, row } = await runRepaint(opts);
        // Opened from a folder with its box ticked, the editor asks for the
        // result there, as the desktop job does.
        if (opts.collectionId) await collectionMethods.collectionAddItems(opts.collectionId, [outputAsset.asset_id]);
        repaintJob = {
          running: false, active: false, status: "succeeded", kind: "ai_repaint",
          finishedAt: Date.now(), error: null,
          result: {
            provider: row.provider, model: row.model,
            output_path: outputAsset.image_path,
            mime_type: "image/png", prompt: row.prompt,
            asset_id: outputAsset.asset_id, notes: [], current_phase: null,
          },
        };
      } catch (err) {
        repaintJob = { running: false, active: false, status: "failed", kind: "ai_repaint", finishedAt: Date.now(), error: err?.message || String(err), result: null };
      }
    })();
    return repaintStatus();
  },
  getAiRepaintStatus: async () => repaintStatus(),
  listRepaintHistory: async (sourcePath) => {
    const source = assets.find((a) => a.image_path === sourcePath);
    if (!source) return [];
    const byId = new Map(assets.map((a) => [a.asset_id, a]));
    return repaintHistory
      .filter((r) => r.source_asset_id === source.asset_id && byId.has(r.output_asset_id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => ({
        asset_id: r.output_asset_id,
        output_path: byId.get(r.output_asset_id).image_path,
        parent_asset_id: r.source_asset_id,
        input_path: source.image_path,
        prompt: r.prompt, provider: r.provider, model: r.model,
        temperature: r.temperature, aspect_ratio: r.aspect_ratio,
        resolution: r.resolution, created_at: r.created_at,
      }));
  },
};
