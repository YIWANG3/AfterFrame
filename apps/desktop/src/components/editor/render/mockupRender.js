// Draw a camera mockup: the display black, the photo played back on it, the
// glass's reflection when asked for, then the camera on top (its picture has
// the display punched out). The background goes down first, by the caller.
// One function for the editor's preview, the export, the template thumbnails
// and the agent's apply_frame, so they can't drift apart.

import { mockupLayout, mockupOutputScale } from "./mockupLayout";
import { loadMockupImage, mockupById, resolveMockupSpec } from "../mockups";

/** A template (built-in or the user's) with its camera mockup settled for a
 *  photo pw×ph ("auto" → the photo's own camera); the template itself when it
 *  has none. */
export function withMockupFor(template, exif, pw, ph) {
  if (!template?.canvas?.mockup) return template;
  return { ...template, canvas: { ...template.canvas, mockup: resolveMockupSpec(template.canvas.mockup, exif, pw, ph) } };
}

/** withMockupFor, with the camera's picture loaded so a render can draw it. */
export async function prepareMockup(template, exif, pw, ph) {
  const ready = withMockupFor(template, exif, pw, ph);
  const id = ready?.canvas?.mockup?.id;
  if (id) await loadMockupImage(id);
  return ready;
}

/** The photo to compose around a template's camera: brought down so the
 *  camera's picture is not blown up past MOCKUP_MAX_UPSCALE (a big photo
 *  plays back at the camera's resolution). The photo itself otherwise. */
export function photoForMockup(template, photo) {
  const spec = template?.canvas?.mockup;
  const asset = spec ? mockupById(spec.id) : null;
  if (!asset) return photo;
  const pw = photo.naturalWidth || photo.width, ph = photo.naturalHeight || photo.height;
  const s = mockupOutputScale(asset, spec, pw, ph);
  if (s >= 1) return photo;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(pw * s));
  small.height = Math.max(1, Math.round(ph * s));
  const ctx = small.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, 0, 0, small.width, small.height);
  return small;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rad > 0 && typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, rad);
  else ctx.rect(x, y, w, h);
}

// A soft sheen across the glass: bright at the top left, gone past a clean
// diagonal edge, the way a window reflects on a camera's display.
function drawReflection(ctx, s) {
  const g = ctx.createLinearGradient(s.x, s.y, s.x + s.width, s.y + s.height);
  g.addColorStop(0, "rgba(255,255,255,0.16)");
  g.addColorStop(0.44, "rgba(255,255,255,0.05)");
  g.addColorStop(0.44, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(s.x, s.y, s.width, s.height);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 * @param {object} o.asset        the camera (mockups.json entry)
 * @param {object} o.spec         canvas.mockup with its camera settled
 * @param {object} o.contentRect  where the photo goes, ctx px: { x, y, width, height }
 * @param {CanvasImageSource} o.photo
 * @param {HTMLImageElement|null} o.image  the camera's picture; null while it
 *   loads (the display and the photo are drawn, the camera is not)
 */
export function drawMockup(ctx, { asset, spec, contentRect, photo, image }) {
  const L = mockupLayout(asset, spec, contentRect);
  const s = L.screen;
  // Black and photo reach a hair under the camera's edge, so nothing behind
  // shows through the soft rim of the punched-out display.
  const bleed = Math.max(1, 1.5 * L.k);
  ctx.save();
  roundRectPath(ctx, s.x - bleed, s.y - bleed, s.width + 2 * bleed, s.height + 2 * bleed, s.radius ? s.radius + bleed : 0);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.clip();
  const pw = photo.width || photo.naturalWidth, ph = photo.height || photo.naturalHeight;
  ctx.drawImage(photo, 0, 0, pw, ph, contentRect.x, contentRect.y, contentRect.width, contentRect.height);
  if (spec.reflection) drawReflection(ctx, s);
  ctx.restore();

  if (!image) return;
  const c = L.camera;
  const w = asset.size[0] * L.k, h = asset.size[1] * L.k;
  ctx.save();
  ctx.translate(c.x + c.width / 2, c.y + c.height / 2);
  if (L.rotation) ctx.rotate((L.rotation * Math.PI) / 180);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  ctx.restore();
}
