// The user's own logos (Settings › Watermark › My logos) on the renderer side.
// The main process stores each as a PNG it made at import (electron/
// personalLogos.js: an SVG is rasterized there), so only pixels arrive here. A
// one-colour logo on a transparent background is recoloured the way
// prepareLogo tints a brand mark: its silhouette filled with the colour.
//
// A layer refers to one as logoRef { source: "personal", id, color } and holds
// the tinted pixels as a data: URL, like a brand logo; a template keeps only
// the ref. A ref whose logo is gone (deleted, or a template imported from
// another machine: settings export does not carry logo files) resolves to
// nothing and the layer is left out.

import api from "../../../api";
import { localFileUrl } from "../../../utils/format";

export const isPersonalLogoRef = (ref) => ref?.source === "personal";

let listPromise = null;
const imageCache = new Map(); // key → Promise<HTMLImageElement|null>

/** The logo list, read once; `fresh` after an import, a rename or a delete. */
export function loadPersonalLogos({ fresh = false } = {}) {
  if (fresh || !listPromise) {
    listPromise = Promise.resolve(api.listPersonalLogos?.())
      .then((res) => (Array.isArray(res?.logos) ? res.logos : []))
      .catch(() => []);
  }
  return listPromise;
}

/** Forget cached logos and pixels (the list changed). */
export function invalidatePersonalLogos() {
  listPromise = null;
  imageCache.clear();
}

export const personalLogoKey = (ref) => `personal:${ref.id}:${ref.color || "orig"}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // media:// is CORS-enabled; an untainted canvas can export
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load logo ${src}`));
    img.src = src;
  });
}

/** A logo, tinted to `color` when it can be, as an Image backed by a data: URL. */
export async function preparePersonalLogo(logo, color) {
  const base = await loadImage(localFileUrl(logo.path));
  const canvas = document.createElement("canvas");
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(base, 0, 0);
  if (color && logo.tintable) {
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return loadImage(canvas.toDataURL("image/png"));
}

/** The images for every personal logoRef given, keyed by personalLogoKey;
 *  refs whose logo no longer exists are simply absent. */
export async function ensurePersonalLogos(refs) {
  const wanted = (refs || []).filter(isPersonalLogoRef);
  const out = new Map();
  if (!wanted.length) return out;
  const logos = await loadPersonalLogos();
  for (const ref of wanted) {
    const key = personalLogoKey(ref);
    if (!imageCache.has(key)) {
      const logo = logos.find((l) => l.id === ref.id);
      imageCache.set(key, logo ? preparePersonalLogo(logo, ref.color).catch(() => null) : Promise.resolve(null));
    }
    const img = await imageCache.get(key);
    if (img) out.set(key, img);
  }
  return out;
}
