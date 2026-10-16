// A paint (solid colour or gradient) as one row: swatch, kind, opacity; and
// the stroke / outline and shadow rows built on it, shared by the text and
// sticker inspectors.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ColorPickerPopover from "../../collage/ColorPickerPopover";
import { NumberInput, Select } from "../../../ui";
import { gradientToCss, hexToRgba } from "../render/canvasHelpers";
import { COLOR_SWATCHES } from "../textState";
import { StackedColorField, StackedField } from "./controls";

// Inline row: [swatch (opens picker)] + [Type dropdown] + [Opacity %] (+ optional trailing).
// All children are 24px tall. Swatch is a 36x24 rectangle so a gradient is legible
// without the endpoint colors looking like a "band" at the edge of a tiny square.
export function PaintRow({ paint, availableModes, onUpdate, opacityValue, onOpacityChange, opacityMax = 100, trailing, multiStop = false }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const swatchRef = useRef(null);
  const isGrad = paint.mode === "gradient";
  const checker = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 5px 5px";
  // The swatch previews the gradient left→right regardless of its angle.
  const swatchBg = isGrad
    ? `${gradientToCss({ ...(multiStop ? paint.gradient : { from: paint.gradient.from, fromOpacity: paint.gradient.fromOpacity, to: paint.gradient.to, toOpacity: paint.gradient.toOpacity }), angle: 90 })}, ${checker}`
    : `linear-gradient(${hexToRgba(paint.color, paint.opacity)}, ${hexToRgba(paint.color, paint.opacity)}), ${checker}`;
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="h-6 w-6 flex-shrink-0 cursor-pointer rounded p-px outline-none bg-transparent"
        title={isGrad ? t("text.editGradient") : t("text.editColor")}
      >
        <span className="block h-full w-full rounded-[3px]" style={{ background: swatchBg }} />
      </button>
      <Select className="flex-1" value={paint.mode} onChange={(mode) => onUpdate({ mode })}>
        {availableModes.includes("solid") && <option value="solid">{t("text.solid")}</option>}
        {availableModes.includes("gradient") && <option value="gradient">{t("text.linear")}</option>}
      </Select>
      {onOpacityChange && (
        <>
          <NumberInput
            drag
            value={opacityValue ?? 100}
            min={0}
            max={opacityMax}
            onChange={onOpacityChange}
            className="w-10"
          />
          <span className="text-[10px] text-muted2">%</span>
        </>
      )}
      {trailing}
      {open && (
        <ColorPickerPopover
          anchorEl={swatchRef.current}
          onClose={() => setOpen(false)}
          presets={COLOR_SWATCHES}
          availableModes={availableModes}
          mode={paint.mode}
          onModeChange={(m) => onUpdate({ mode: m })}
          color={paint.color}
          onChange={(c) => onUpdate({ color: c })}
          opacity={paint.opacity}
          onOpacityChange={(o) => onUpdate({ opacity: o })}
          gradient={paint.gradient}
          onGradientChange={(g) => onUpdate({ gradient: g })}
          multiStop={multiStop}
        />
      )}
    </div>
  );
}

// Shared stroke/outline row — PaintRow with a trailing px NumberInput. Used for
// both the text Stroke section and the sticker Outline section so visual
// changes only need to happen here.
export function StrokeFieldRow({ paint, availableModes, onPaintUpdate, width, maxWidth, onWidthChange }) {
  return (
    <PaintRow
      paint={paint}
      availableModes={availableModes}
      onUpdate={onPaintUpdate}
      trailing={
        <>
          <NumberInput
            drag
            value={width ?? 0}
            min={0}
            max={maxWidth}
            onChange={onWidthChange}
            className="w-10"
          />
          <span className="text-[10px] text-muted2">px</span>
        </>
      }
    />
  );
}

// Shared shadow row — color picker + X/Y/Blur stacked fields. Used by both
// text and sticker shadows (field names are identical: shadowColor/X/Y/Blur/
// shadowOpacity). Caller passes the layer and a patch-style onChange.
export function ShadowFieldRow({ layer, onChange }) {
  const { t } = useTranslation("editor");
  return (
    <div className="mt-2 flex items-stretch gap-2">
      <StackedColorField
        label={t("text.color")}
        color={layer.shadowColor}
        onChange={(c) => onChange({ shadowColor: c })}
        opacity={(layer.shadowOpacity ?? 60) / 100}
        onOpacityChange={(v) => onChange({ shadowOpacity: Math.round(v * 100) })}
        presets={COLOR_SWATCHES}
      />
      <StackedField label="X" value={layer.shadowX} min={-50} max={50} onChange={(v) => onChange({ shadowX: v })} />
      <StackedField label="Y" value={layer.shadowY} min={-50} max={50} onChange={(v) => onChange({ shadowY: v })} />
      <StackedField label={t("text.blur")} value={layer.shadowBlur} min={0} max={100} onChange={(v) => onChange({ shadowBlur: v })} />
    </div>
  );
}
