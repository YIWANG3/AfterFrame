// Where a camera mockup goes around a photo: the camera's picture scaled so
// its display holds the photo, the way a camera plays a photo back. "contain"
// shows the whole photo with black bars on the rest of the display; "fill"
// covers the display and cuts the photo's overflow. A photo whose orientation
// is not the display's gets the camera turned on its side.
//
// Pure geometry. The canvas margins (imageMath.resolveCanvasPad), the renderer
// (mockupRender) and the editor's preview all lay the mockup out here, so they
// can't drift apart.
//
// `asset` is a mockups.json entry: { size: [w, h], screen: { x, y, w, h, radius } }
// with the display as fractions of the picture and its corner radius as a
// fraction of the display's short side. `spec` is canvas.mockup:
// { id, fit: "contain" | "fill", rotation: "auto" | 0 | -90 | 90, reflection }.

// The camera picture is never blown up past this: an export of a big photo is
// drawn smaller instead (mockupOutputScale).
export const MOCKUP_MAX_UPSCALE = 1.5;

export const MOCKUP_FITS = ["contain", "fill"];

const LEAN = 1.02; // a shape counts as landscape or portrait past this ratio

/** The quarter turn a mockup gets (degrees, clockwise): the spec's own, or for
 *  "auto" a turn to the left when the photo's orientation is not the
 *  display's (a camera held upright for a portrait). */
export function mockupRotation(asset, spec, cw, ch) {
  const r = spec?.rotation;
  if (r === 0 || r === -90 || r === 90) return r;
  const sw = asset.screen.w * asset.size[0], sh = asset.screen.h * asset.size[1];
  const screenWide = sw > sh * LEAN, screenTall = sh > sw * LEAN;
  const photoWide = cw > ch * LEAN, photoTall = ch > cw * LEAN;
  return (screenWide && photoTall) || (screenTall && photoWide) ? -90 : 0;
}

/** The picture and its display after a quarter turn, in the picture's px. */
export function turnedAsset(asset, rotation) {
  const [W, H] = asset.size;
  const s = { x: asset.screen.x * W, y: asset.screen.y * H, w: asset.screen.w * W, h: asset.screen.h * H };
  // −90: (x, y) → (y, W − x); +90: (x, y) → (H − y, x).
  if (rotation === -90) return { w: H, h: W, screen: { x: s.y, y: W - s.x - s.w, w: s.h, h: s.w } };
  if (rotation === 90) return { w: H, h: W, screen: { x: H - s.y - s.h, y: s.x, w: s.h, h: s.w } };
  return { w: W, h: H, screen: s };
}

/**
 * Lay the mockup around a photo drawn at `content` ({ x, y, width, height },
 * any px). The display's centre sits on the photo's centre.
 * @returns {{ rotation: number, k: number,
 *   camera: { x, y, width, height }, screen: { x, y, width, height, radius } }}
 *   k: output px per picture px; camera: the turned picture's box.
 */
export function mockupLayout(asset, spec, content) {
  const cw = content.width, ch = content.height;
  const rotation = mockupRotation(asset, spec, cw, ch);
  const t = turnedAsset(asset, rotation);
  const k = spec?.fit === "fill"
    ? Math.min(cw / t.screen.w, ch / t.screen.h)
    : Math.max(cw / t.screen.w, ch / t.screen.h);
  const camX = content.x + cw / 2 - (t.screen.x + t.screen.w / 2) * k;
  const camY = content.y + ch / 2 - (t.screen.y + t.screen.h / 2) * k;
  const sw = t.screen.w * k, sh = t.screen.h * k;
  return {
    rotation, k,
    camera: { x: camX, y: camY, width: t.w * k, height: t.h * k },
    screen: {
      x: camX + t.screen.x * k, y: camY + t.screen.y * k, width: sw, height: sh,
      radius: (asset.screen.radius || 0) * Math.min(sw, sh),
    },
  };
}

/** The margins (px) from the photo's edges out to the camera's, for a photo
 *  cw×ch: what the canvas needs around the photo to hold the camera. */
export function mockupBodyPad(asset, spec, cw, ch) {
  const { camera } = mockupLayout(asset, spec, { x: 0, y: 0, width: cw, height: ch });
  return {
    top: Math.max(0, -camera.y),
    right: Math.max(0, camera.x + camera.width - cw),
    bottom: Math.max(0, camera.y + camera.height - ch),
    left: Math.max(0, -camera.x),
  };
}

/** How much smaller an output around a photo cw×ch (at full size) is drawn so
 *  the camera picture is not blown up past MOCKUP_MAX_UPSCALE. 1 = full size. */
export function mockupOutputScale(asset, spec, cw, ch) {
  const { k } = mockupLayout(asset, spec, { x: 0, y: 0, width: cw, height: ch });
  return k > 0 ? Math.min(1, MOCKUP_MAX_UPSCALE / k) : 1;
}
