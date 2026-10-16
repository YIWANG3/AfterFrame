// The text panel's small controls: section chrome, icon buttons, the
// scrub-to-adjust number cells, segmented groups, link toggles, the preset
// chip and the alignment bar.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Columns2, Rows2, Layers, Link, Unlink,
} from "lucide-react";
import ColorPickerPopover from "../../collage/ColorPickerPopover";
import { NumberInput } from "../../../ui";
import { hexToRgba } from "../render/canvasHelpers";
import {
  alignLeft, alignCenterH, alignRight,
  alignTop, alignCenterV, alignBottom,
  distributeH, distributeV,
} from "../textAlign";

export function Section({ label, action, right, children }) {
  return (
    <div className="border-b border-border/60 px-4 py-3" data-editor-section={label}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{label}</span>
        {action || right || null}
      </div>
      {children}
    </div>
  );
}

export function IconBtn({ icon: Icon, onClick, title, disabled }) {
  return (
    <button
      type="button"
      className="flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40 disabled:pointer-events-none"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      <Icon className={["h-3.5 w-3.5", disabled && Icon === Layers ? "animate-pulse" : ""].join(" ")} />
    </button>
  );
}

// Scrub-to-adjust numeric field with its label underneath (Sketch-style
// Size / Spacing / Line cells).
export function FieldCell({ label, value, min, max, onChange }) {
  return (
    <div>
      <NumberInput drag value={value} min={min} max={max} onChange={onChange} className="w-full" />
      <div className="mt-0.5 truncate text-center text-[9px] text-muted2">{label}</div>
    </div>
  );
}

// Segmented control — one bordered container, equal-width cells with inner
// dividers. Keeps rows of related toggles reading as a single unit instead of
// scattered pills.
export function SegGroup({ options, className }) {
  return (
    <div className={["flex h-6 overflow-hidden rounded-md border border-border/60", className || ""].join(" ")}>
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          className={[
            "flex h-full min-w-[30px] flex-1 items-center justify-center px-2 text-[11px] font-semibold transition-colors",
            i > 0 ? "border-l border-border/60" : "",
            o.active
              ? "bg-[rgb(var(--accent-color)/0.12)] text-[rgb(var(--accent-color))]"
              : "text-muted hover:bg-hover hover:text-text",
          ].join(" ")}
          onClick={o.onClick}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function StackedField({ label, value, onChange, min, max }) {
  return (
    <div className="flex flex-1 min-w-0 flex-col items-center gap-1">
      <NumberInput drag value={value} min={min} max={max} onChange={onChange} className="w-full" />
      <span className="text-[10px] text-muted2">{label}</span>
    </div>
  );
}

// Stacked color field — small square swatch + label below. Width hugs the
// swatch so the rest of the row's stacked fields can share remaining space.
export function StackedColorField({ label, color, onChange, opacity, onOpacityChange, presets }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const swatchRef = useRef(null);
  const checker = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 6px 6px";
  const fill = `linear-gradient(${hexToRgba(color, opacity ?? 1)}, ${hexToRgba(color, opacity ?? 1)}), ${checker}`;
  return (
    <div className="flex flex-shrink-0 flex-col items-start gap-1">
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="h-6 w-6 cursor-pointer rounded p-px outline-none bg-transparent"
        title={t("text.editColor")}
      >
        <span className="block h-full w-full rounded-[3px]" style={{ background: fill }} />
      </button>
      <span className="text-[10px] text-muted2">{label}</span>
      {open && (
        <ColorPickerPopover
          anchorEl={swatchRef.current}
          onClose={() => setOpen(false)}
          color={color}
          onChange={onChange}
          opacity={opacity}
          onOpacityChange={onOpacityChange}
          presets={presets}
        />
      )}
    </div>
  );
}

export function PairedFields({
  leftLabel, leftValue, onLeftChange,
  rightLabel, rightValue, onRightChange,
  min, max,
  linked, onToggleLink, linkTitle,
}) {
  return (
    <div className="flex flex-1 min-w-0 flex-col gap-1">
      <div className="flex items-stretch gap-2">
        <NumberInput drag value={leftValue} min={min} max={max} onChange={onLeftChange} className="min-w-0 flex-1" />
        <NumberInput drag value={rightValue} min={min} max={max} onChange={onRightChange} className="min-w-0 flex-1" />
      </div>
      <div className="relative flex items-center">
        <span className="flex-1 text-center text-[10px] text-muted2">{leftLabel}</span>
        <span className="flex-1 text-center text-[10px] text-muted2">{rightLabel}</span>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <LinkBtn linked={linked} onClick={onToggleLink} title={linkTitle} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LinkBtn({ linked, onClick, title }) {
  const Icon = linked ? Link : Unlink;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        "flex h-5 w-5 items-center justify-center rounded transition-colors",
        linked ? "text-[rgb(var(--accent-color))] hover:bg-[rgb(var(--accent-color)/0.12)]" : "text-muted2 hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

export function PresetPreview({ preset }) {
  const s = preset.style;
  const gradient = s.fillMode === "gradient";
  const style = {
    fontSize: "16px",
    fontWeight: s.fontWeight ?? (s.bold ? 700 : 400),
    fontStyle: s.italic ? "italic" : "normal",
    fontFamily: `"${s.fontFamily || "Plus Jakarta Sans"}", sans-serif`,
    // Tracking capped so wide presets (Dune 55%) still fit the tiny chip while
    // reading as "spaced"; case renders via the same JS-equivalent transform.
    letterSpacing: `${Math.min(s.tracking ?? 0, 0.25) * 16}px`,
    textTransform: s.textCase === "upper" ? "uppercase" : s.textCase === "lower" ? "lowercase" : undefined,
    color: s.fillColor === "transparent" ? "transparent" : (s.fillColor || "#fff"),
    ...(gradient
      ? {
          backgroundImage: `linear-gradient(${s.gradientAngle ?? 90}deg, ${s.gradientFrom}, ${s.gradientTo})`,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          color: "transparent",
        }
      : {}),
    WebkitTextStroke: s.strokeEnabled ? `${s.strokeWidth || 1}px ${s.strokeColor || "#fff"}` : undefined,
    textShadow: !gradient && s.shadow ? `${s.shadowX || 0}px ${s.shadowY || 0}px ${s.shadowBlur || 0}px ${s.shadowColor || "#000"}` : undefined,
    filter: gradient && s.shadow ? `drop-shadow(${s.shadowX || 0}px ${s.shadowY || 0}px ${s.shadowBlur || 0}px ${s.shadowColor || "#000"})` : undefined,
    opacity: s.opacity != null ? s.opacity / 100 : 1,
  };
  const bg = s.bgMode === "solid" ? { background: s.bgColor || "#000", padding: "2px 6px", borderRadius: "3px" } : {};
  return <div className="flex h-7 items-center justify-center" style={{ ...style, ...bg }}>Aa</div>;
}

export function AlignBar({ layers, onLayersChange, allLayers }) {
  const { t } = useTranslation("editor");
  const apply = (fn) => {
    const updated = fn(layers);
    const map = new Map(updated.map((l) => [l.id, l]));
    onLayersChange(allLayers.map((l) => map.get(l.id) || l));
  };

  const abtn = "flex h-6 w-6 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text";
  const sep = "mx-0.5 h-3.5 w-px bg-border/60";

  return (
    <div className="mt-2 flex items-center gap-0.5 rounded-md bg-app p-1">
      <button type="button" className={abtn} title={t("text.align.left")} onClick={() => apply(alignLeft)}><AlignHorizontalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title={t("text.align.centerH")} onClick={() => apply(alignCenterH)}><AlignHorizontalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title={t("text.align.right")} onClick={() => apply(alignRight)}><AlignHorizontalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title={t("text.align.top")} onClick={() => apply(alignTop)}><AlignVerticalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title={t("text.align.centerV")} onClick={() => apply(alignCenterV)}><AlignVerticalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title={t("text.align.bottom")} onClick={() => apply(alignBottom)}><AlignVerticalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title={t("text.align.distributeH")} onClick={() => apply(distributeH)}><Columns2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title={t("text.align.distributeV")} onClick={() => apply(distributeV)}><Rows2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}
