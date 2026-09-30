// Which logo a camera brand (or one model) uses: its own (the first cell:
// the built-in marks, "follow the brand" for a model, or none), or one of
// this brand's camera logos; the last cell uploads a new one for the brand,
// which is picked at once. Hover a logo to delete it. In the Frame tool's
// camera logo rows (a popover) and Settings › Watermark.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import api from "../../../api";
import { localFileUrl } from "../../../utils/format";
import { confirm } from "../../confirm";
import { invalidatePersonalLogos, loadPersonalLogos, subscribePersonalLogos } from "../render/personalLogos";

// A logo preview cell: the sticker checkerboard.
export const LOGO_TILE = "flex h-10 w-full items-center justify-center rounded-md border border-border/60 bg-checker p-1.5 text-text transition-colors hover:border-border";

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

/** A logo's preview. A one-colour logo is only a shape (frames colour it for
 *  what is behind it), so it is drawn in the text colour and shows on the
 *  checkerboard whether it is black or white; a logo of several colours keeps
 *  them. */
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
 * @param {string} [props.defaultLabel]  under the first cell ("Default", "Follow brand")
 * @param {(logo: object) => number} [props.rankOf]  lower first (this brand's logos, say);
 *   Infinity leaves a logo out (custom ones, another brand's)
 * @param {object} [props.importOptions]  what an upload is ({ kind: "camera", brand })
 */
export default function LogoPicker({ title, selectedId, defaultMarks = [], defaultLabel, onPick, rankOf, importOptions }) {
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
    const res = await api.importPersonalLogo(importOptions);
    if (res?.error) { setError(res); return; }
    if (res?.canceled || !res?.logo) return;
    invalidatePersonalLogos();
    onPick(res.logo);
  }
  // A brand that used it goes back to its default (the main process sees to it).
  async function remove(logo) {
    const ok = await confirm({
      title: t("border.deleteLogoTitle", { name: logo.name }), message: t("border.deleteLogoMessage"),
      confirmLabel: t("border.delete"), cancelLabel: t("actions.cancel", { ns: "common" }), danger: true,
    });
    if (!ok) return;
    await api.deletePersonalLogo(logo.id);
    invalidatePersonalLogos();
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
            <div className={CAPTION}>{defaultLabel || t("frame.logoDefault")}</div>
          </div>
          {(rankOf
            ? (logos || []).filter((logo) => rankOf(logo) !== Infinity).sort((a, b) => rankOf(a) - rankOf(b))
            : logos || []).map((logo) => (
            <div key={logo.id} className="group relative">
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
              <button
                type="button" title={t("border.delete")} aria-label={t("border.delete")}
                data-delete-logo={logo.id}
                onClick={() => remove(logo)}
                className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-chrome/90 text-muted2 hover:text-text group-hover:flex"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {canImport && (
            <button
              type="button"
              data-picker-import="true"
              title={t("frame.uploadCameraHint")}
              onClick={importLogo}
              className="flex h-10 items-center justify-center gap-1 rounded-md border border-dashed border-border/70 text-[10.5px] text-muted transition-colors hover:border-border hover:text-text"
            >
              <Plus className="h-3 w-3" />
              {t("frame.uploadCamera")}
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
