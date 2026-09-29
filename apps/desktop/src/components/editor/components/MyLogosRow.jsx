// "Logo" in the Frame tool: this photo's camera logos first (every built-in
// mark: Sony's α and SONY, each its own cell; or the one of mine the camera
// was given), then my logos that no camera uses (a signature, a studio mark).
// Click any to put it in the frame (the editor decides where and in what
// colour: logoPlacement.js). The camera cell's caption ("FC9184 ▾") opens a
// small chooser for which logo this model, or the whole brand, uses: its own,
// or one of mine that is free or already this brand's (another brand's logo
// is that brand's and not offered). A logo given to a camera appears only
// through that camera's cell. Two imports, each saying what it is for: the
// chooser's gives the camera a logo; the last cell here ("Signature / my
// logo") adds one of mine for every photo, placed at once. Hover one of mine
// to rename or delete it.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import api from "../../../api";
import { localFileUrl } from "../../../utils/format";
import InlineEdit from "../../InlineEdit";
import { confirm } from "../../confirm";
import { invalidatePersonalLogos, loadPersonalLogos, subscribePersonalLogos } from "../render/personalLogos";
import LogoPicker, { LOGO_TILE, LogoPreview } from "./LogoPicker";

const CAPTION = "mt-0.5 truncate px-0.5 text-center text-[9.5px] text-muted2";

export default function MyLogosRow({ onPlace, cameraLogo, brandLogos, onPlaceCameraLogo, onChooseCameraLogo }) {
  const { t } = useTranslation("editor");
  const [logos, setLogos] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [scope, setScope] = useState("brand"); // the chooser sets: "model" | "brand"
  const rowRef = useRef(null);
  const canImport = api.has("importPersonalLogo");

  // Reload on any change, wherever it was made (Settings, a drop on the editor).
  useEffect(() => {
    let alive = true;
    const load = () => loadPersonalLogos({ fresh: true }).then((list) => { if (alive) setLogos(list); });
    load();
    const unsubscribe = subscribePersonalLogos(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  // The chooser closes on a click elsewhere or Esc (which then does not also
  // close the editor).
  useEffect(() => {
    if (!choosing) return undefined;
    const onPointer = (event) => { if (!rowRef.current?.contains(event.target)) setChoosing(false); };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setChoosing(false);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [choosing]);

  async function importLogo() {
    setError(null);
    const res = await api.importPersonalLogo();
    if (res?.error) { setError(res); return; }
    if (res?.canceled || !res?.logo) return;
    invalidatePersonalLogos();
    onPlace?.(res.logo);
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

  // Logos a camera uses (brandLogos values) show only through its cell.
  const usedBy = new Map();
  for (const [key, id] of Object.entries(brandLogos || {})) usedBy.set(id, [...(usedBy.get(id) || []), key]);
  const free = (logos || []).filter((logo) => !usedBy.has(logo.id));

  // Nothing to show where logos cannot be imported, none are free and the
  // camera is unknown (web).
  if (!canImport && !free.length && !cameraLogo) return null;

  const logoOf = (id) => (logos || []).find((logo) => logo.id === id) || null;
  const chosen = cameraLogo?.choice ? logoOf(cameraLogo.choice) : null;
  // The camera's cells: my logo it was given, else each built-in mark.
  const markOf = (logo) => ({ id: null, src: localFileUrl(logo.path), tintable: logo.tintable });
  const cameraMarks = chosen ? [markOf(chosen)] : cameraLogo?.choice ? [] : cameraLogo?.builtInMarks || [];
  const cameraColumns = Math.min(3, Math.max(1, cameraMarks.length));
  const hasModel = !!cameraLogo?.modelKey;
  const openChooser = () => {
    setScope(hasModel && cameraLogo.modelChoice ? "model" : "brand");
    setChoosing(true);
  };
  // In the chooser: this brand's logos (its models' too), then free ones;
  // one another brand uses is left out.
  const rankOf = (logo) => {
    const keys = usedBy.get(logo.id);
    if (!keys) return 1;
    return keys.some((key) => key === cameraLogo?.key || key.startsWith(`${cameraLogo?.key}#`)) ? 0 : Infinity;
  };
  const brandChosen = cameraLogo?.brandChoice ? logoOf(cameraLogo.brandChoice) : null;
  const scopeButton = (value, label) => (
    <button
      type="button"
      data-scope={value}
      aria-pressed={scope === value}
      onClick={() => setScope(value)}
      className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${scope === value ? "bg-[var(--fill-2)] text-text" : "text-muted2 hover:text-text"}`}
    >
      {label}
    </button>
  );

  return (
    <div ref={rowRef} className="relative" data-my-logos="true">
      <div className="mb-1.5 text-[10px] text-muted2">{t("frame.logos")}</div>
      <div className="grid grid-cols-3 gap-1.5">
        {cameraLogo && (
          // One cell per mark, the same size as the rest: two take two
          // columns; three or more take the whole row and wrap.
          <div
            data-camera-logo={cameraLogo.key}
            data-camera-logo-choice={cameraLogo.choice || ""}
            style={{ gridColumn: `span ${cameraColumns}` }}
          >
            {cameraMarks.length ? (
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cameraColumns}, minmax(0, 1fr))` }}>
                {cameraMarks.map((mark) => (
                  <button
                    key={mark.src}
                    type="button"
                    data-place-camera-logo="true"
                    data-mark={mark.id || "mine"}
                    title={t("frame.placeCameraLogo")}
                    onClick={() => onPlaceCameraLogo?.(mark.id)}
                    className={LOGO_TILE}
                  >
                    <LogoPreview src={mark.src} tintable={mark.tintable} alt={cameraLogo.name} />
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                data-set-camera-logo="true"
                title={t("frame.chooseCameraLogo", { name: cameraLogo.model || cameraLogo.name })}
                onClick={openChooser}
                className="flex h-10 w-full items-center justify-center rounded-md border border-dashed border-border/70 text-muted2 transition-colors hover:border-border hover:text-text"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              data-change-camera-logo="true"
              aria-expanded={choosing}
              title={[cameraLogo.name, cameraLogo.model].filter(Boolean).join(" · ")}
              onClick={() => (choosing ? setChoosing(false) : openChooser())}
              className="mt-0.5 flex w-full items-center justify-center gap-0.5 px-0.5 text-[9.5px] text-muted2 transition-colors hover:text-text"
            >
              <Camera className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{cameraLogo.model || cameraLogo.name}</span>
              <ChevronDown className="h-2.5 w-2.5 shrink-0" />
            </button>
          </div>
        )}
        {free.map((logo) => (
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
            title={t("frame.importMineHint")}
            onClick={importLogo}
            className="flex h-10 items-center justify-center gap-1 rounded-md border border-dashed border-border/70 px-1 text-[10.5px] leading-tight text-muted transition-colors hover:border-border hover:text-text"
          >
            <Plus className="h-3 w-3 shrink-0" />
            {t("frame.importMine")}
          </button>
        )}
      </div>
      {error && (
        <div className="mt-1 text-[10.5px] text-error">
          {t(`border.logoErrors.${error.error}`, { message: error.message || "", defaultValue: t("border.logoErrors.failed", { message: error.error }) })}
        </div>
      )}
      {choosing && cameraLogo && (
        <div className="absolute inset-x-0 z-20 mt-1 rounded-lg border border-border/70 bg-chrome p-2 shadow-overlay">
          <LogoPicker
            title={hasModel ? (
              <div className="flex gap-0.5 rounded-md bg-app p-0.5" data-logo-scope="true">
                {scopeButton("model", cameraLogo.model)}
                {scopeButton("brand", t("frame.allOfBrand", { name: cameraLogo.name }))}
              </div>
            ) : t("frame.cameraLogoFor", { name: cameraLogo.name })}
            selectedId={scope === "model" ? cameraLogo.modelChoice : cameraLogo.brandChoice}
            // A model's "Default" is whatever its brand uses.
            defaultMarks={scope === "model" && brandChosen ? [markOf(brandChosen)] : cameraLogo.builtInMarks}
            rankOf={rankOf}
            onPick={(logo) => { setChoosing(false); onChooseCameraLogo?.(logo, scope); }}
          />
        </div>
      )}
    </div>
  );
}
