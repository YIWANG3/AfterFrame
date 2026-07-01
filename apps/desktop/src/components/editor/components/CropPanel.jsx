// Crop / transform tool panel: aspect-ratio presets, quarter-turn + flip
// buttons, the image-scale slider, and the reset/undo/redo/apply footer.
// Presentational — the parent (EditorOverlay) owns all state and passes the
// commit handlers + current values. Extracted from EditorOverlay (Phase 4) so
// the crop tool matches the <TextPanel>/<FramePanel>/... shape.

import {
  RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, Undo2, Redo2, Check,
} from "lucide-react";
import { ASPECT_PRESETS, getAspectRatio } from "../cropMath";
import { MAX_IMAGE_ZOOM } from "../imageMath";

function FooterButton({ icon: Icon, label, onClick, disabled = false, primary = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex h-8 items-center rounded-md text-[11px] font-medium transition-colors disabled:cursor-default disabled:opacity-35",
        label ? "gap-1.5 px-3" : "w-8 justify-center",
        primary
          ? "bg-[rgb(var(--accent-color))] text-black hover:brightness-110"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label ? <span>{label}</span> : null}
    </button>
  );
}

function getAspectPreviewBox(aspectKey) {
  const aspect = getAspectRatio(aspectKey, 1);
  if (!aspect) {
    return { width: 14, height: 10, dashed: true };
  }
  const max = 14;
  if (aspect >= 1) {
    return { width: max, height: Math.max(6, Math.round(max / aspect)), dashed: false };
  }
  return { width: Math.max(6, Math.round(max * aspect)), height: max, dashed: false };
}

function AspectButton({ preset, active, onClick }) {
  const preview = getAspectPreviewBox(preset.key);

  return (
    <button
      type="button"
      className={[
        "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] transition-colors",
        active ? "bg-selected text-accent" : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="flex h-4 w-4 items-center justify-center shrink-0">
        <span
          className="block border border-current opacity-70"
          style={{
            width: `${preview.width}px`,
            height: `${preview.height}px`,
            borderStyle: preview.dashed ? "dashed" : "solid",
            borderRadius: "3px",
          }}
        />
      </span>
      <span>{preset.label}</span>
    </button>
  );
}

export default function CropPanel({
  t,
  aspectKey, onCommitAspect,
  quarterTurns, flipX, flipY, onCommitTransform,
  imageZoom, minZoom, onZoomChange,
  onReset, canReset,
  onUndo, canUndo,
  onRedo, canRedo,
  onApply, canApply,
}) {
  return (
    <>
      <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("overlay.aspectRatio")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {ASPECT_PRESETS.map((preset) => (
              <AspectButton
                key={preset.key}
                preset={preset}
                active={aspectKey === preset.key}
                onClick={() => onCommitAspect(preset.key)}
              />
            ))}
          </div>
        </div>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("overlay.tools.transform")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-md bg-app px-3 py-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
              onClick={() => onCommitTransform({ quarterTurns: ((quarterTurns - 1) % 4 + 4) % 4, freeAngle: 0 })}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("overlay.rotateLeft")}
            </button>
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-md bg-app px-3 py-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
              onClick={() => onCommitTransform({ quarterTurns: (quarterTurns + 1) % 4, freeAngle: 0 })}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("overlay.rotateRight")}
            </button>
            <button
              type="button"
              className={[
                "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[11px] transition-colors",
                flipX ? "bg-selected text-accent" : "bg-app text-muted hover:bg-hover hover:text-text",
              ].join(" ")}
              onClick={() => onCommitTransform({ flipX: !flipX })}
            >
              <FlipHorizontal2 className="h-3.5 w-3.5" />
              {t("overlay.flipH")}
            </button>
            <button
              type="button"
              className={[
                "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[11px] transition-colors",
                flipY ? "bg-selected text-accent" : "bg-app text-muted hover:bg-hover hover:text-text",
              ].join(" ")}
              onClick={() => onCommitTransform({ flipY: !flipY })}
            >
              <FlipVertical2 className="h-3.5 w-3.5" />
              {t("overlay.flipV")}
            </button>
          </div>
        </div>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("overlay.scale")}</div>
            <div className="text-[11px] text-muted">{imageZoom.toFixed(2)}×</div>
          </div>
          <input
            type="range"
            min={String(minZoom)}
            max={String(MAX_IMAGE_ZOOM)}
            step="0.01"
            value={imageZoom}
            onChange={(event) => onZoomChange(Number(event.target.value))}
            className="mt-3 w-full"
            aria-label={t("overlay.imageScale")}
          />
        </div>

      </div>

      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <FooterButton icon={RotateCcw} label={t("overlay.reset")} onClick={onReset} disabled={!canReset} />
        <FooterButton icon={Undo2} label="" onClick={onUndo} disabled={!canUndo} />
        <FooterButton icon={Redo2} label="" onClick={onRedo} disabled={!canRedo} />
        <div className="flex-1" />
        <FooterButton icon={Check} label={t("overlay.apply")} onClick={onApply} disabled={!canApply} primary />
      </div>
    </>
  );
}
