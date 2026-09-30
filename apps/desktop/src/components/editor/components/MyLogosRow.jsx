// "Custom" in the Frame tool: my logos that belong to no camera (a
// signature, a studio mark), for every photo. Click one to put it in the
// frame (the editor decides where and in what colour: logoPlacement.js);
// hover one to rename or delete it. The last cell uploads more, several at a
// time; a single one is placed at once. Camera logos are the row above
// (CameraLogosBlock) and never show here. Settings › Watermark › Custom
// lists the same logos.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import api from "../../../api";
import { localFileUrl } from "../../../utils/format";
import InlineEdit from "../../InlineEdit";
import { confirm } from "../../confirm";
import { invalidatePersonalLogos, loadPersonalLogos, subscribePersonalLogos } from "../render/personalLogos";
import { LOGO_TILE, LogoPreview } from "./LogoPicker";

const CAPTION = "mt-0.5 truncate px-0.5 text-center text-[9.5px] text-muted2";

export default function MyLogosRow({ onPlace }) {
  const { t } = useTranslation("editor");
  const [logos, setLogos] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [error, setError] = useState(null);
  const canImport = api.has("importPersonalLogo");

  // Reload on any change, wherever it was made (Settings, a drop on the editor).
  useEffect(() => {
    let alive = true;
    const load = () => loadPersonalLogos({ fresh: true }).then((list) => { if (alive) setLogos(list); });
    load();
    const unsubscribe = subscribePersonalLogos(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  async function upload() {
    setError(null);
    const res = await api.importPersonalLogo({ kind: "custom", multiple: true });
    if (res?.error) { setError(res); return; }
    if (res?.canceled || !res?.logos?.length) return;
    invalidatePersonalLogos();
    if (res.logos.length === 1) onPlace?.(res.logos[0]);
  }
  async function remove(logo) {
    const ok = await confirm({
      title: t("border.deleteLogoTitle", { name: logo.name }), message: t("border.deleteLogoMessage"),
      confirmLabel: t("border.delete"), cancelLabel: t("actions.cancel", { ns: "common" }), danger: true,
    });
    if (!ok) return;
    await api.deletePersonalLogo(logo.id);
    invalidatePersonalLogos();
  }

  const custom = (logos || []).filter((logo) => logo.kind !== "camera");
  // Nothing to show where logos cannot be uploaded and there are none (web).
  if (!canImport && !custom.length) return null;

  return (
    <div data-my-logos="true">
      <div className="grid grid-cols-3 gap-1.5">
        {custom.map((logo) => (
          <div key={logo.id} className="group relative" data-my-logo={logo.id}>
            <button
              type="button"
              title={`${logo.name} · ${t("border.placeLogo")}`}
              onClick={() => onPlace?.(logo)}
              className={LOGO_TILE}
            >
              <LogoPreview src={localFileUrl(logo.path)} tintable={logo.tintable} alt={logo.name} />
            </button>
            {renaming === logo.id ? (
              <div className="mt-0.5 rounded border border-border/70 bg-app text-[10px]">
                <InlineEdit
                  initial={logo.name}
                  onConfirm={async (name) => {
                    setRenaming(null);
                    await api.renamePersonalLogo(logo.id, name);
                    invalidatePersonalLogos();
                  }}
                  onCancel={() => setRenaming(null)}
                />
              </div>
            ) : (
              <div className={CAPTION}>{logo.name}</div>
            )}
            <div className="absolute right-0.5 top-0.5 hidden gap-0.5 group-hover:flex">
              <button
                type="button" title={t("border.rename")} aria-label={t("border.rename")}
                onClick={() => setRenaming(logo.id)}
                className="flex h-4 w-4 items-center justify-center rounded bg-chrome/90 text-muted2 hover:text-text"
              >
                <Pencil className="h-2.5 w-2.5" />
              </button>
              <button
                type="button" title={t("border.delete")} aria-label={t("border.delete")}
                onClick={() => remove(logo)}
                className="flex h-4 w-4 items-center justify-center rounded bg-chrome/90 text-muted2 hover:text-text"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>
        ))}
        {canImport && (
          <button
            type="button"
            data-import-my-logo="true"
            title={t("frame.uploadCustomHint")}
            onClick={upload}
            className="flex h-10 items-center justify-center gap-1 rounded-md border border-dashed border-border/70 px-1 text-[10.5px] text-muted transition-colors hover:border-border hover:text-text"
          >
            <Plus className="h-3 w-3 shrink-0" />
            {t("frame.uploadCustom")}
          </button>
        )}
      </div>
      {error && (
        <div className="mt-1 text-[10.5px] text-error">
          {t(`border.logoErrors.${error.error}`, { message: error.message || "", defaultValue: t("border.logoErrors.failed", { message: error.error }) })}
        </div>
      )}
    </div>
  );
}
