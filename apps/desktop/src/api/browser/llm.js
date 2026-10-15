// Image and text plumbing shared by the two BYOK fetch paths (ai.js repaint,
// annotation.js).

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
