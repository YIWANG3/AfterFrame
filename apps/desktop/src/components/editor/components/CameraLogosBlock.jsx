// "Camera logo" in the Frame tool: this photo's camera, in two rows.
//   Brand (every model of it): the built-in marks, each its own cell (Sony's
//   α and SONY), or the logo of mine the brand was given.
//   Model (this one only; a drone's lenses named the same are one): its own
//   logo, built in (Luna Ultra) or mine; with none, frames use the brand's.
// Click a cell to put it in the frame. A row's caption opens its chooser:
// Default, this brand's camera logos, or an upload that becomes one.
// Custom logos (a signature) are another row (MyLogosRow) and never mix in.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus } from "lucide-react";
import { localFileUrl } from "../../../utils/format";
import { loadPersonalLogos, subscribePersonalLogos } from "../render/personalLogos";
import LogoPicker, { LOGO_TILE, LogoPreview } from "./LogoPicker";

const markOf = (logo) => ({ id: null, src: localFileUrl(logo.path), tintable: logo.tintable });

export default function CameraLogosBlock({ cameraLogo, onPlace, onChoose }) {
  const { t } = useTranslation("editor");
  const [logos, setLogos] = useState([]);
  const [choosing, setChoosing] = useState(null); // "brand" | "model" | null
  const rootRef = useRef(null);

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
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setChoosing(null); };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setChoosing(null);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [choosing]);

  if (!cameraLogo) return null;
  const logoOf = (id) => logos.find((logo) => logo.id === id) || null;
  const brandMine = cameraLogo.brandChoice ? logoOf(cameraLogo.brandChoice) : null;
  const modelMine = cameraLogo.modelChoice ? logoOf(cameraLogo.modelChoice) : null;
  const brandCells = brandMine ? [markOf(brandMine)] : cameraLogo.brandMarks;
  const modelCells = modelMine ? [markOf(modelMine)] : cameraLogo.modelMarks;
  // In a chooser: this brand's camera logos only.
  const rankOf = (logo) => (logo.kind === "camera" && logo.brand === cameraLogo.brandKey ? 0 : Infinity);

  const caption = (level, tag, name) => (
    <button
      type="button"
      data-change-camera-logo={level}
      aria-expanded={choosing === level}
      title={t(level === "brand" ? "frame.brandLogoFor" : "frame.modelLogoFor", { name })}
      onClick={() => setChoosing((open) => (open === level ? null : level))}
      className="mb-1 flex max-w-full items-center gap-1 text-[10px] text-muted2 transition-colors hover:text-text"
    >
      <span className="shrink-0 rounded bg-[var(--fill-2)] px-1 py-px text-[9.5px]">{tag}</span>
      <span className="truncate text-muted">{name}</span>
      <ChevronDown className="h-2.5 w-2.5 shrink-0" />
    </button>
  );
  const cells = (level, marks) => (
    <div className="grid grid-cols-3 gap-1.5">
      {marks.map((mark) => (
        <button
          key={mark.src}
          type="button"
          data-place-camera-logo={level}
          data-mark={mark.id || "mine"}
          title={t("frame.placeCameraLogo")}
          onClick={() => onPlace?.({ level, variant: mark.id || undefined })}
          className={LOGO_TILE}
        >
          <LogoPreview src={mark.src} tintable={mark.tintable} alt={cameraLogo.brandName} />
        </button>
      ))}
      {!marks.length && (
        <button
          type="button"
          data-set-camera-logo={level}
          title={t(level === "brand" ? "frame.brandLogoFor" : "frame.modelLogoFor", { name: level === "brand" ? cameraLogo.brandName : cameraLogo.modelName })}
          onClick={() => setChoosing(level)}
          className="flex h-10 w-full items-center justify-center rounded-md border border-dashed border-border/70 text-muted2 transition-colors hover:border-border hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const scope = choosing;
  return (
    <div ref={rootRef} className="relative" data-camera-logos="true" data-camera-logo={cameraLogo.brandKey}>
      <div data-camera-level="brand" data-camera-logo-choice={cameraLogo.brandChoice || ""}>
        {caption("brand", t("frame.levelBrand"), cameraLogo.brandName)}
        {cells("brand", brandCells)}
      </div>
      {cameraLogo.modelKey && (
        <div className="mt-2" data-camera-level="model" data-camera-logo-choice={cameraLogo.modelChoice || ""}>
          {caption("model", t("frame.levelModel"), cameraLogo.modelName)}
          {cells("model", modelCells)}
        </div>
      )}
      {scope && (
        <div className="absolute inset-x-0 z-20 mt-1 rounded-lg border border-border/70 bg-chrome p-2 shadow-overlay">
          <LogoPicker
            title={t(scope === "brand" ? "frame.brandLogoFor" : "frame.modelLogoFor", { name: scope === "brand" ? cameraLogo.brandName : cameraLogo.modelName })}
            selectedId={scope === "brand" ? cameraLogo.brandChoice : cameraLogo.modelChoice}
            // A model's Default: its built-in logo, else whatever the brand shows.
            defaultMarks={scope === "brand" ? cameraLogo.brandMarks : (cameraLogo.modelMarks.length ? cameraLogo.modelMarks : brandCells)}
            defaultLabel={scope === "model" && !cameraLogo.modelMarks.length ? t("frame.followBrand") : undefined}
            rankOf={rankOf}
            importOptions={{ kind: "camera", brand: cameraLogo.brandKey }}
            onPick={(logo) => { setChoosing(null); onChoose?.(logo, scope); }}
          />
        </div>
      )}
    </div>
  );
}
