// Which logo a camera brand's frames use: its own (the first cell: the
// built-in mark, or none for a camera without one), or one of my logos; the
// last cell imports a new one, which is picked at once. In the Frame tool's
// Logo row (a popover under the camera cell) and Settings › Watermark.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import api from "../../../api";
import { localFileUrl } from "../../../utils/format";
import { invalidatePersonalLogos, loadPersonalLogos, subscribePersonalLogos } from "../render/personalLogos";

// A logo preview cell: the sticker checkerboard.
export const LOGO_TILE = "flex h-10 w-full items-center justify-center rounded-md border border-border/60 bg-checker p-1.5 text-text transition-colors hover:border-border";

/** A logo's preview. A one-colour logo is only a shape (frames colour it for
 *  what is behind it), so it is drawn in the text colour and shows on the
 *  checkerboard whether it is black or white; a logo of several colours keeps
 *  them. */
/** A brand's own marks as one small preview (Sony: α and SONY): the first
 *  `max` side by side, and how many more ("+2") for a brand with more. */
export function LogoMarks({ marks, alt = "", max = 2 }) {
  const shown = marks.slice(0, max);
  const more = marks.length - shown.length;
  if (shown.length === 1 && !more) return <LogoPreview src={shown[0].src} tintable={shown[0].tintable} alt={alt} />;
  return (
    <span className="flex h-full w-full items-center justify-center gap-1.5">
      {shown.map((mark) => (
        <span key={mark.src} className="flex h-full min-w-0 flex-1 items-center justify-center">
          <LogoPreview src={mark.src} tintable={mark.tintable} alt={alt} />
        </span>
      ))}
      {more > 0 && <span data-more-marks={more} className="shrink-0 text-[10px] text-muted2">+{more}</span>}
    </span>
  );
}

export function LogoPreview({ src, tintable, alt = "" }) {
  if (!tintable) return <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />;
  const mask = { maskImage: `url("${src}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" };
  return (
    <span
      role="img"
      aria-label={alt}
      data-logo-shape="true"
      className="block h-full w-full bg-current"
      style={{ ...mask, WebkitMaskImage: mask.maskImage, WebkitMaskSize: "contain", WebkitMaskRepeat: "no-repeat", WebkitMaskPosition: "center" }}
    />
  );
}
const PICKED = "!border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color))]";
const CAPTION = "mt-0.5 truncate px-0.5 text-center text-[9.5px] text-muted2";

/**
 * @param {object} props
 * @param {import("react").ReactNode} props.title
 * @param {string|null} props.selectedId  my logo in use, or null: the brand's own
 * @param {Array<{src: string, tintable: boolean}>} props.defaultMarks  what Default gives
 *   (the brand's own marks, or for a model the brand's logo); empty: none
 * @param {(logo: object|null) => void} props.onPick  null: the brand's own
 * @param {(logo: object) => number} [props.rankOf]  lower first (this brand's logos, say);
 *   Infinity leaves a logo out (one another brand uses)
 */
export default function LogoPicker({ title, selectedId, defaultMarks = [], onPick, rankOf }) {
  const { t } = useTranslation("editor");
  const [logos, setLogos] = useState(null);
  const [error, setError] = useState(null);
  const canImport = api.has("importPersonalLogo");

  useEffect(() => {
    let alive = true;
    const load = () => loadPersonalLogos({ fresh: true }).then((list) => { if (alive) setLogos(list); });
    load();
    const unsubscribe = subscribePersonalLogos(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  async function importLogo() {
    setError(null);
    const res = await api.importPersonalLogo();
    if (res?.error) { setError(res); return; }
    if (res?.canceled || !res?.logo) return;
    invalidatePersonalLogos();
    onPick(res.logo);
  }

  return (
    <div data-logo-picker="true">
      {title && <div className="mb-1.5 truncate text-[10.5px] text-muted">{title}</div>}
      {/* The scroller wraps the grid: a grid that is its own scroll container
          is laid out a row too tall in Chromium. */}
      <div className="max-h-44 overflow-y-auto p-px">
        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <button
              type="button"
              data-pick-default="true"
              aria-pressed={!selectedId}
              onClick={() => onPick(null)}
              className={defaultMarks.length
                ? `${LOGO_TILE} ${!selectedId ? PICKED : ""}`
                : `flex h-10 w-full items-center justify-center rounded-md border border-dashed border-border/70 text-[10.5px] text-muted2 transition-colors hover:border-border ${!selectedId ? PICKED : ""}`}
            >
              {defaultMarks.length ? <LogoMarks marks={defaultMarks} /> : t("frame.logoNone")}
            </button>
            <div className={CAPTION}>{t("frame.logoDefault")}</div>
          </div>
          {(rankOf
            ? (logos || []).filter((logo) => rankOf(logo) !== Infinity).sort((a, b) => rankOf(a) - rankOf(b))
            : logos || []).map((logo) => (
            <div key={logo.id}>
              <button
                type="button"
                data-pick-logo={logo.id}
                title={logo.name}
                aria-pressed={logo.id === selectedId}
                onClick={() => onPick(logo)}
                className={`${LOGO_TILE} ${logo.id === selectedId ? PICKED : ""}`}
              >
                <LogoPreview src={localFileUrl(logo.path)} tintable={logo.tintable} alt={logo.name} />
              </button>
              <div className={CAPTION}>{logo.name}</div>
            </div>
          ))}
          {canImport && (
            <button
              type="button"
              data-picker-import="true"
              title={t("border.importLogoHint")}
              onClick={importLogo}
              className="flex h-10 items-center justify-center gap-1 rounded-md border border-dashed border-border/70 text-[10.5px] text-muted transition-colors hover:border-border hover:text-text"
            >
              <Plus className="h-3 w-3" />
              {t("border.importLogo")}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-1 text-[10.5px] text-error">
          {t(`border.logoErrors.${error.error}`, { message: error.message || "", defaultValue: t("border.logoErrors.failed", { message: error.error }) })}
        </div>
      )}
    </div>
  );
}
