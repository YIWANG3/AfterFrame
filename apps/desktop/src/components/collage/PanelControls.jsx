import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import ColorPickerPopover from "./ColorPickerPopover";
import { fileName, localFileUrl } from "../../utils/format";

// Shared building blocks for CollagePanel (single mode) and BatchPanel
// (batch mode): section chrome, template thumbnails, and the canvas/export
// settings that are identical in both modes.

export const ASPECT_OPTIONS = [
  { value: 1, label: "1:1" },
  { value: 3 / 4, label: "3:4" },
  { value: 4 / 3, label: "4:3" },
  { value: 2 / 3, label: "2:3" },
  { value: 3 / 2, label: "3:2" },
  { value: 16 / 9, label: "16:9" },
  { value: 9 / 16, label: "9:16" },
  { value: 9 / 19.5, label: "Full" },
];

export const BG_PRESETS = [
  "#000000", "#2c2c2c", "#555555",
  "#ffffff", "#f5f0e8", "#0a1628",
  "#1e3a2f", "#3b1a1a", "#2d1b30",
];

export const EXPORT_WIDTHS = [1080, 2048, 3000, 4096];

/**
 * The "Images" section: every image in the collage (thumb + name, hover to
 * remove) plus an add button. The list caps its height and scrolls inside so
 * a long selection doesn't push the rest of the panel out of reach.
 */
export function ImagesSection({ images, onRemove, onAdd, maxListHeight = 264 }) {
  const { t } = useTranslation("collage");
  return (
    <Section label={t("images")}>
      <div className="-mx-1.5 space-y-0.5 overflow-y-auto pr-0.5" style={{ maxHeight: `${maxListHeight}px` }} data-testid="collage-image-list">
        {images.map((item, i) => {
          const src = item.preview_path || item.image_preview_path || item.image_path;
          const name = fileName(item.image_path || item.stem || "");
          return (
            <div
              key={item.asset_id || i}
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover/60"
            >
              {src && (
                <img
                  src={localFileUrl(src)}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded object-cover"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{name}</span>
              <button
                type="button"
                className="rounded p-0.5 text-muted2 opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
                onClick={() => onRemove(item, i)}
                title={t("remove")}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 py-2 text-[11px] text-muted transition-colors hover:border-border hover:text-text"
        onClick={onAdd}
      >
        <Plus className="h-3 w-3" />
        {t("addImages")}
      </button>
    </Section>
  );
}

export function PanelLabel({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{children}</div>;
}

export function Section({ label, children }) {
  return (
    <div className="border-b border-border/60 px-4 py-3">
      <PanelLabel>{label}</PanelLabel>
      <div className="mt-3">{children}</div>
    </div>
  );
}

// Template thumbnail SVG — solid fill style like Meitu
export function TemplateThumb({ tmpl, ratio = 1, isActive }) {
  const viewSize = 36;
  const iconSize = 20;
  const innerW = ratio >= 1 ? iconSize : Math.round(iconSize * ratio);
  const innerH = ratio >= 1 ? Math.round(iconSize / ratio) : iconSize;
  const ox = (viewSize - innerW) / 2;
  const oy = (viewSize - innerH) / 2;
  const gap = 2;
  const color = isActive
    ? "rgb(var(--accent-color))"
    : "rgb(var(--muted-text-2) / 0.55)";
  return (
    <svg viewBox={`0 0 ${viewSize} ${viewSize}`} className="h-full w-full">
      {tmpl.cells.map((cell, ci) => {
        const x = ox + cell.x * innerW + gap / 2;
        const y = oy + cell.y * innerH + gap / 2;
        const w = cell.w * innerW - gap;
        const h = cell.h * innerH - gap;
        return (
          <rect
            key={ci}
            x={x} y={y}
            width={Math.max(w, 1)} height={Math.max(h, 1)}
            rx={0.8}
            fill={color}
          />
        );
      })}
    </svg>
  );
}

export function TemplateGrid({ templates, activeId, ratio, onSelect }) {
  return (
    <div className="grid grid-cols-5 gap-0.5">
      {templates.map((tmpl) => (
        <button
          key={tmpl.id}
          type="button"
          className="flex items-center justify-center h-10 w-10 hover:opacity-70 transition-opacity"
          onClick={() => onSelect(tmpl)}
          title={tmpl.name}
        >
          <TemplateThumb tmpl={tmpl} ratio={ratio} isActive={tmpl.id === activeId} />
        </button>
      ))}
    </div>
  );
}

function SliderField({ label, value, max, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted">{label}</div>
        <div className="text-[11px] text-muted2">{value}px</div>
      </div>
      <input type="range" min={0} max={max} step={1} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full" />
    </div>
  );
}

/**
 * The "Canvas" section: aspect ratio, gap, padding, border radius, background.
 * Identical between single and batch modes.
 */
export function CanvasSection({
  canvasRatio,
  onCanvasRatioChange,
  gap,
  onGapChange,
  padding,
  onPaddingChange,
  borderRadius,
  onBorderRadiusChange,
  bgColor,
  onBgColorChange,
  exportWidth,
}) {
  const { t } = useTranslation("collage");
  const [customRatioW, setCustomRatioW] = useState("");
  const [customRatioH, setCustomRatioH] = useState("");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const customColorBtnRef = useRef(null);

  return (
    <Section label={t("canvas")}>
      <div className="space-y-3">
        <div>
          <div className="text-[11px] text-muted">{t("aspectRatio")}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ASPECT_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                className={[
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  Math.abs(canvasRatio - opt.value) < 0.01
                    ? "bg-selected text-text"
                    : "bg-app text-muted hover:bg-hover hover:text-text",
                ].join(" ")}
                onClick={() => { onCanvasRatioChange(opt.value); setCustomRatioW(""); setCustomRatioH(""); }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              placeholder="3"
              value={customRatioW}
              onChange={(e) => {
                setCustomRatioW(e.target.value);
                const w = Number(e.target.value);
                const h = Number(customRatioH);
                if (w > 0 && h > 0) onCanvasRatioChange(w / h);
              }}
              className="w-16 rounded-md bg-app px-2 py-1 text-center text-[11px] text-text outline-none border border-border/40 focus:border-[rgb(var(--accent-color)/0.5)]"
            />
            <span className="text-[11px] text-muted2">:</span>
            <input
              type="number"
              min={1}
              placeholder="4"
              value={customRatioH}
              onChange={(e) => {
                setCustomRatioH(e.target.value);
                const w = Number(customRatioW);
                const h = Number(e.target.value);
                if (w > 0 && h > 0) onCanvasRatioChange(w / h);
              }}
              className="w-16 rounded-md bg-app px-2 py-1 text-center text-[11px] text-text outline-none border border-border/40 focus:border-[rgb(var(--accent-color)/0.5)]"
            />
          </div>
        </div>

        <SliderField label={t("gap")} value={gap} max={Math.round(exportWidth * 0.1)} onChange={onGapChange} />
        <SliderField label={t("padding")} value={padding} max={Math.round(exportWidth * 0.1)} onChange={onPaddingChange} />
        <SliderField label={t("borderRadius")} value={borderRadius} max={Math.round(exportWidth * 0.15)} onChange={onBorderRadiusChange} />

        <div>
          <div className="text-[11px] text-muted">{t("background")}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {BG_PRESETS.map((color) => {
              const isActive = bgColor.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  className={[
                    "h-6 w-6 rounded-full border-2 transition-colors",
                    isActive
                      ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color)/0.3)]"
                      : "border-transparent hover:border-border",
                  ].join(" ")}
                  onClick={() => { onBgColorChange(color); setShowColorPicker(false); }}
                  title={color}
                >
                  <div
                    className="h-full w-full rounded-full"
                    style={{ backgroundColor: color, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)" }}
                  />
                </button>
              );
            })}
            {/* Custom color button */}
            <button
              ref={customColorBtnRef}
              type="button"
              className={[
                "h-6 w-6 rounded-full border-2 transition-colors",
                !BG_PRESETS.some((c) => c.toLowerCase() === bgColor.toLowerCase())
                  ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color)/0.3)]"
                  : "border-transparent hover:border-border",
              ].join(" ")}
              onClick={() => setShowColorPicker((v) => !v)}
              title={t("customColor")}
            >
              <div
                className="h-full w-full rounded-full"
                style={{
                  backgroundColor: BG_PRESETS.some((c) => c.toLowerCase() === bgColor.toLowerCase()) ? undefined : bgColor,
                  background: BG_PRESETS.some((c) => c.toLowerCase() === bgColor.toLowerCase())
                    ? "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
                    : undefined,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
                }}
              />
            </button>
          </div>
          {showColorPicker && (
            <ColorPickerPopover
              color={bgColor}
              onChange={onBgColorChange}
              onClose={() => setShowColorPicker(false)}
              anchorEl={customColorBtnRef.current}
            />
          )}
        </div>
      </div>
    </Section>
  );
}

export function ExportWidthChips({ exportWidth, onExportWidthChange }) {
  return (
    <div className="flex flex-wrap gap-1">
      {EXPORT_WIDTHS.map((w) => (
        <button
          key={w}
          type="button"
          className={[
            "rounded-md px-2.5 py-1 text-[11px] transition-colors",
            exportWidth === w
              ? "bg-selected text-text"
              : "bg-app text-muted hover:bg-hover hover:text-text",
          ].join(" ")}
          onClick={() => onExportWidthChange(w)}
        >
          {w}px
        </button>
      ))}
    </div>
  );
}
