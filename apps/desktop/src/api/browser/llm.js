// Image and text plumbing shared by the two BYOK fetch paths (ai.js repaint,
// annotation.js).

// The annotation system prompt is the sidecar's own file
// (services/sidecar/src/media_workspace/data/annotation_prompt.json, aliased
// in vite.config.js / vite.web.config.js): one text, both builds.
import PROMPT from "@sidecar-data/annotation_prompt.json";

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime || "image/png" });
}

export const randomHex = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)))
  .map((b) => b.toString(16).padStart(2, "0")).join("");

// Sidecar encode_image_for_llm: RGB, longest edge 512, JPEG q85, base64.
export async function encodeImageForLlm(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // flatten alpha like the RGB conversion
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  return await blobToBase64(jpeg);
}

// Sidecar parse_llm_json: strip fences, else grab the first {...} block.
export function parseLlmJson(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  if (fence) t = fence[1];
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error("Model did not return valid JSON.");
}

// Sidecar annotation._has_cjk: a CJK ideograph marks a Chinese tag.
const hasCjk = (text) => /[\u4e00-\u9fff]/.test(text);

// Sidecar annotation.filter_tags_by_language.
export function filterTagsByLanguage(tags, languages) {
  const wantEn = languages.includes("en");
  const wantZh = languages.includes("zh");
  if (wantEn && wantZh) return tags;
  return tags.filter((tag) => (hasCjk(tag) ? wantZh : wantEn));
}

// Sidecar annotation.build_system_prompt, step for step: the shared template
// filled in, then the library's tag sample and the user's instructions.
export function buildAnnotationSystemPrompt({ languages = ["en", "zh"], maxTags = 10, maxCaptionChars = 200, customInstructions = null, existingTags = [] }) {
  const wantEn = languages.includes("en");
  const wantZh = languages.includes("zh");
  const langClause = PROMPT.lang_clause[wantEn && wantZh ? "en+zh" : wantEn ? "en" : "zh"];
  let prompt = String(PROMPT.template)
    .replaceAll("{max_caption_chars}", String(maxCaptionChars))
    .replaceAll("{max_tags}", String(maxTags))
    .replaceAll("{lang_clause}", langClause);
  if (existingTags.length) {
    const sample = filterTagsByLanguage(existingTags, languages).slice(0, PROMPT.tag_reuse_hint_limit);
    if (sample.length) prompt += PROMPT.tag_pool_intro + sample.join(", ");
  }
  if (customInstructions) prompt += PROMPT.custom_instructions_intro + customInstructions.trim();
  return prompt;
}
