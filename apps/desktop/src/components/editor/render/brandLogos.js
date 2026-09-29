// The logo registry as frames use it: the built-in brand marks with the
// user's choices folded in (watermarkProfile.brandLogos → one of my logos,
// frameLogos.withBrandLogos). The editor's Frame tool and the agent's
// apply_frame both load it here, so a choice shows the same everywhere.

import api from "../../../api";
import { buildLogoRegistry, prepareLogo, withBrandLogos } from "./frameLogos";
import { ensurePersonalLogos, loadPersonalLogos, personalLogoKey, subscribePersonalLogos } from "./personalLogos";

/**
 * @returns {Promise<{ base: object, registry: object, svgs: object, brandLogos: object }>}
 *   base: the built-in brands only; registry: with the user's choices
 */
export async function loadLogoRegistry() {
  const [res, profile, personal] = await Promise.all([
    api.getFrameLogos(),
    api.getWatermarkProfile?.().catch(() => null),
    loadPersonalLogos(),
  ]);
  const base = res ? buildLogoRegistry(res.manifest) : { byId: new Map(), match: {} };
  const brandLogos = profile?.brandLogos || {};
  return { base, registry: withBrandLogos(base, brandLogos, personal), svgs: res?.svgs || {}, brandLogos };
}

/** The image for one collectLogoNeeds() need: a built-in mark drawn from its
 *  SVG, or my logo tinted as the need asks. Null when it cannot be had. */
export async function prepareLogoNeed(need, svgs) {
  if (need.personal) {
    const ref = { source: "personal", id: need.personal, color: need.colorLocked ? null : need.color };
    return (await ensurePersonalLogos([ref])).get(personalLogoKey(ref)) || null;
  }
  const svg = svgs?.[need.file];
  if (!svg) return null;
  return prepareLogo(svg, {
    color: need.color,
    colorLocked: need.colorLocked,
    tintableColors: need.tintableColors,
    heightPx: need.heightPx,
  });
}

const listeners = new Set();

/** Give a brand one of my logos, or (logoId null) its own back, and tell
 *  whoever shows frames. */
export async function setBrandLogo(brandKey, logoId) {
  const profile = await api.setBrandLogo(brandKey, logoId || null);
  for (const listener of listeners) listener();
  return profile;
}

/** Called when a brand's logo choice changes, or my logos do (a logo a brand
 *  uses may have been deleted); returns the unsubscribe. */
export function subscribeBrandLogos(listener) {
  listeners.add(listener);
  const unsubscribePersonal = subscribePersonalLogos(listener);
  return () => {
    listeners.delete(listener);
    unsubscribePersonal();
  };
}
