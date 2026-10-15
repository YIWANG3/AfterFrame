// AI annotation (Anthropic / OpenAI-compatible direct fetch, sidecar
// annotation.py semantics), the photos' tags, and the batch annotation job.

import { assets, collections, emitCatalogChanged, jobStatus, normalizeTag, persistTokens, sessionTokens, showDescription } from "./state";
import { aggregateTags } from "./query";
import { buildAnnotationSystemPrompt, encodeImageForLlm, parseLlmJson } from "./llm";

const ANNOTATION_SETTINGS_KEY = "afterframe.annotationSettings";
let annotationJob = null; // batch job singleton

function readAnnotationSettings() {
  try { return JSON.parse(localStorage.getItem(ANNOTATION_SETTINGS_KEY)) || {}; } catch { return {}; }
}

async function setAssetAnnotation(assetId, annotation) {
  const a = assets.find((x) => x.asset_id === assetId);
  if (a) a.annotation = annotation;
  return annotation;
}

async function callAnnotationProvider({ provider, model, baseUrl, apiKey, systemPrompt, promptText, imageB64 }) {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey || "",
        "anthropic-version": "2023-06-01",
        // Official opt-in for browser BYOK — the user's own key, stored locally.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
            { type: "text", text: promptText },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const payload = await res.json();
    const block = (payload.content || []).find((b) => b.type === "text");
    if (!block?.text) throw new Error("Anthropic returned no text content.");
    return block.text;
  }
  const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
            { type: "text", text: promptText },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible API HTTP ${res.status} at ${base}: ${(await res.text()).slice(0, 300)}`);
  const payload = await res.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Provider returned no content.");
  return typeof text === "string" ? text : JSON.stringify(text);
}

async function annotateOne(opts) {
  const asset = assets.find((a) => a.asset_id === opts.assetId)
    || assets.find((a) => a.image_path === opts.imagePath);
  if (!asset) throw new Error("Asset not found.");
  const apiKey = opts.apiKey || sessionTokens.get(`annotation:${opts.providerId}`)?.token || null;
  const blob = await (await fetch(asset.image_path)).blob();
  const imageB64 = await encodeImageForLlm(blob);
  const systemPrompt = buildAnnotationSystemPrompt({
    languages: opts.languages,
    maxTags: opts.maxTags,
    maxCaptionChars: opts.maxCaptionChars,
    customInstructions: opts.customInstructions,
    existingTags: aggregateTags(200).map((t) => t.value),
  });
  let promptText = "Annotate this image as instructed.";
  if (opts.hint) promptText += ` User correction: this photo was taken at/in: ${opts.hint}. Trust this over visual inference.`;
  const raw = await callAnnotationProvider({
    provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl,
    apiKey, systemPrompt, promptText, imageB64,
  });
  const parsed = parseLlmJson(raw);
  const now = new Date().toISOString();
  const maxTags = opts.maxTags || 10;
  const maxCaption = opts.maxCaptionChars || 200;
  const aiTags = [...new Set((Array.isArray(parsed.tags) ? parsed.tags : [])
    .map((t) => (typeof t === "string" ? t : t?.tag))
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => normalizeTag(t)))]
    .slice(0, maxTags);
  // The run's tags join the photo's: the previous run's are replaced, the
  // user's stay (and an AI tag the user has is still the user's).
  const userTags = (asset.tags || []).filter((t) => !(asset.aiTags || []).includes(t));
  asset.aiTags = aiTags.filter((t) => !userTags.includes(t));
  asset.tags = [...userTags, ...asset.aiTags];
  const annotation = {
    asset_id: asset.asset_id,
    provider: opts.provider,
    model: opts.model || null,
    schema_version: 1,
    caption: typeof parsed.caption === "string" ? parsed.caption.slice(0, maxCaption) : "",
    tags: asset.tags,
    ai_tags: aiTags,
    location: parsed.location && typeof parsed.location === "object" && !Array.isArray(parsed.location) ? parsed.location : null,
    detected_text: typeof parsed.detected_text === "string" ? parsed.detected_text : null,
    created_at: now,
    updated_at: now,
  };
  await setAssetAnnotation(asset.asset_id, annotation);
  showDescription(asset);
  return annotation;
}

// GET the provider's model list — cheapest possible connectivity/CORS probe.
async function probeAnnotationEndpoint({ providerId, provider, apiKey, baseUrl } = {}) {
  const key = apiKey || sessionTokens.get(`annotation:${providerId}`)?.token || null;
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": key || "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()).data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }
  const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = await res.json();
  return (payload.data || payload.models || [])
    // Annotation needs a vision model — when the endpoint advertises input
    // modalities (OpenRouter does), keep only image-capable entries.
    .filter((m) => {
      const modalities = m.architecture?.input_modalities;
      return !Array.isArray(modalities) || modalities.includes("image");
    })
    .map((m) => ({ id: m.id || m.name, label: m.name || m.id }))
    .filter((m) => m.id);
}

// A fetch that dies before reaching the server ("Failed to fetch") is, on a
// BYOK page, almost always a missing CORS header on the endpoint.
function corsFriendlyError(e) {
  const msg = e?.message || String(e);
  return /failed to fetch|load failed|networkerror/i.test(msg)
    ? "Request never reached the endpoint — it likely does not allow browser cross-origin requests (CORS), or the URL is unreachable."
    : msg;
}

// Payload fields AnnotationsSection sends for a single asset — the batch job
// derives the same from stored settings.
function annotationOptsFromSettings(settings) {
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
  if (!active) throw new Error("No annotation provider configured.");
  return {
    providerId: active.id,
    provider: active.type === "anthropic" ? "anthropic" : "openai_compatible",
    model: active.model,
    baseUrl: active.baseUrl || null,
    languages: settings.languages || ["en", "zh"],
    maxTags: settings.maxTags || 10,
    maxCaptionChars: settings.maxCaptionChars || 200,
    customInstructions: settings.customInstructions || null,
  };
}

function resolveAnnotationTargets({ scope = "all", onlyMissing = true, assetIds = null, collectionId = null } = {}) {
  let list = assets;
  if (Array.isArray(assetIds) && assetIds.length) {
    const wanted = new Set(assetIds);
    list = list.filter((a) => wanted.has(a.asset_id));
  } else if (scope === "collection" && collectionId) {
    const row = collections.find((c) => c.collection_id === collectionId);
    const member = new Set(row?.asset_ids || []);
    list = list.filter((a) => member.has(a.asset_id));
  }
  if (onlyMissing) list = list.filter((a) => !a.annotation);
  return list;
}

// The running batch job as a getActiveJobs row, or null.
export function activeAnnotationJob() {
  if (!annotationJob?.running) return null;
  return {
    jobId: annotationJob.jobId,
    jobType: "annotation",
    kind: "annotation",
    running: true,
    status: "running",
    progress: annotationJob.progress,
    result: { current_phase: { result: { processed: annotationJob.done, total: annotationJob.total } } },
  };
}

// A tag by hand: onto the photo's tags (no annotation is made — a
// hand-tagged photo is still un-annotated). One the AI proposed becomes the user's.
async function addAssetTag(assetId, tag) {
  const asset = assets.find((a) => a.asset_id === assetId);
  if (!asset) return null;
  const t = normalizeTag(tag);
  if (t) {
    asset.tags = asset.tags || [];
    if (!asset.tags.includes(t)) asset.tags = [...asset.tags, t];
    asset.aiTags = (asset.aiTags || []).filter((x) => x !== t);
    if (asset.annotation) asset.annotation = { ...asset.annotation, tags: asset.tags };
  }
  return { asset_id: assetId, tags: asset.tags || [] };
}

export const annotationMethods = {
  getAnnotationSettings: async () => readAnnotationSettings(),
  saveAnnotationSettings: async (next) => {
    const merged = { ...readAnnotationSettings(), ...(next || {}) };
    localStorage.setItem(ANNOTATION_SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  },
  getAnnotationKey: async (id) => sessionTokens.get(`annotation:${id}`) || null,
  setAnnotationKey: async (id, token) => { sessionTokens.set(`annotation:${id}`, { token }); persistTokens(); return { token }; },
  deleteAnnotationKey: async (id) => { sessionTokens.delete(`annotation:${id}`); persistTokens(); },
  annotateAsset: async (opts = {}) => {
    return await annotateOne(opts);
  },
  getAnnotation: async (assetId) => {
    return assets.find((a) => a.asset_id === assetId)?.annotation || null;
  },
  addAssetTag,
  getAssetTags: async (assetId) => {
    const asset = assets.find((a) => a.asset_id === assetId);
    return { asset_id: assetId, tags: asset?.tags || [] };
  },
  addAssetTags: async (assetIds, tags) => {
    const updated = [];
    for (const assetId of new Set(assetIds || [])) {
      if (!assets.some((a) => a.asset_id === assetId)) continue;
      for (const tag of tags || []) await addAssetTag(assetId, tag);
      updated.push(assetId);
    }
    return { ok: true, asset_ids: updated, tags: [...new Set((tags || []).map(normalizeTag).filter(Boolean))] };
  },
  removeAssetTag: async (assetId, tag) => {
    const asset = assets.find((a) => a.asset_id === assetId);
    if (!asset) return null;
    const t = normalizeTag(tag);
    asset.tags = (asset.tags || []).filter((x) => normalizeTag(x) !== t);
    asset.aiTags = (asset.aiTags || []).filter((x) => normalizeTag(x) !== t);
    if (asset.annotation) asset.annotation = { ...asset.annotation, tags: asset.tags };
    return { asset_id: assetId, tags: asset.tags };
  },
  clearAiLocation: async (assetId) => {
    const asset = assets.find((a) => a.asset_id === assetId);
    if (!asset?.annotation) return asset?.annotation || null;
    return await setAssetAnnotation(assetId, { ...asset.annotation, location: null, updated_at: new Date().toISOString() });
  },
  countAnnotationTargets: async (opts = {}) => {
    return { count: resolveAnnotationTargets(opts).length };
  },
  startAnnotationJob: async (opts = {}) => {
    if (annotationJob?.running) return jobStatus(annotationJob);
    const targets = resolveAnnotationTargets(opts);
    const shared = annotationOptsFromSettings(readAnnotationSettings()); // throws when unconfigured
    annotationJob = { jobId: `web-annotate-${Date.now()}`, running: true, active: true, status: "running", kind: "annotation", progress: 0, done: 0, failed: 0, total: targets.length };
    void (async () => {
      for (const asset of targets) {
        try {
          await annotateOne({ ...shared, assetId: asset.asset_id, imagePath: asset.image_path });
        } catch { annotationJob.failed += 1; }
        annotationJob.done += 1;
        annotationJob.progress = annotationJob.total ? annotationJob.done / annotationJob.total : 1;
      }
      annotationJob.running = false;
      annotationJob.active = false;
      annotationJob.status = "succeeded";
      annotationJob.finishedAt = Date.now();
      emitCatalogChanged("assets");
    })();
    return jobStatus(annotationJob);
  },
  getAnnotationJobStatus: async () => (annotationJob ? jobStatus(annotationJob) : jobStatus()),
  // Cheap connectivity probes (a /models GET, no tokens spent) — on the web
  // these double as a CORS check, since a blocked preflight fails right here.
  testAnnotationConnection: async (opts = {}) => {
    try {
      const models = await probeAnnotationEndpoint(opts);
      return { ok: true, info: `${models.length} models` };
    } catch (e) { return { ok: false, error: corsFriendlyError(e) }; }
  },
  listAnnotationModels: async (opts = {}) => {
    try { return { ok: true, models: await probeAnnotationEndpoint(opts) }; }
    catch (e) { return { ok: false, error: corsFriendlyError(e) }; }
  },
};
