import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { getTemplatesForCount } from "./collageTemplates";
import { fileName, localFileUrl } from "../../utils/format";
import ColorPickerPopover from "./ColorPickerPopover";

const ASPECT_OPTIONS = [
  { value: 1, label: "1:1" },
  { value: 3 / 4, label: "3:4" },
  { value: 4 / 3, label: "4:3" },
  { value: 2 / 3, label: "2:3" },
  { value: 3 / 2, label: "3:2" },
  { value: 16 / 9, label: "16:9" },
  { value: 9 / 16, label: "9:16" },
  { value: 9 / 19.5, label: "Full" },
];

const BG_PRESETS = [
  "#000000", "#2c2c2c", "#555555",
  "#ffffff", "#f5f0e8", "#0a1628",
  "#1e3a2f", "#3b1a1a", "#2d1b30",
];

function PanelLabel({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{children}</div>;
}

function Section({ label, children }) {
  return (
    <div className="border-b border-border/60 px-4 py-3">
      <PanelLabel>{label}</PanelLabel>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function CollagePanel({
  images,
  onImagesChange,
  template,
  onTemplateChange,
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
  onExportWidthChange,
  onAddImages,
}) {
  const templates = useMemo(() => getTemplatesForCount(images.length), [images.length]);
  const [showCustomColor, setShowCustomColor] = useState(false);
  const [customRatioW, setCustomRatioW] = useState("");
  const [customRatioH, setCustomRatioH] = useState("");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const customColorBtnRef = useRef(null);

  const isCustomRatio = !ASPECT_OPTIONS.some((opt) => Math.abs(canvasRatio - opt.value) < 0.01);

  function removeImage(index) {
    const next = images.filter((_, i) => i !== index);
    onImagesChange(next);
  }

  // Render template thumbnail SVG — solid fill style like Meitu
  function renderTemplateSvg(tmpl, isActive) {
    const ratio = canvasRatio || 1;
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section label="Images">
        <div className="space-y-0.5">
          {images.map((item, i) => {
            const src = item.preview_path || item.export_preview_path || item.export_path;
            const name = fileName(item.export_path || item.stem || "");
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
                  onClick={() => removeImage(i)}
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
          onClick={onAddImages}
        >
          <Plus className="h-3 w-3" />
          Add images
        </button>
      </Section>

      <Section label="Layout">
        <div className="grid grid-cols-5 gap-0.5">
          {templates.map((tmpl) => {
            const isActive = template?.id === tmpl.id;
            return (
              <button
                key={tmpl.id}
                type="button"
                className="flex items-center justify-center h-10 w-10 hover:opacity-70 transition-opacity"
                onClick={() => onTemplateChange(tmpl)}
                title={tmpl.name}
              >
                {renderTemplateSvg(tmpl, isActive)}
              </button>
            );
          })}
        </div>
      </Section>

      <Section label="Canvas">
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-muted">Aspect Ratio</div>
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

          <div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted">Gap</div>
              <div className="text-[11px] text-muted2">{gap}px</div>
            </div>
            <input type="range" min={0} max={Math.round(exportWidth * 0.1)} step={1} value={gap}
              onChange={(e) => onGapChange(Number(e.target.value))} className="mt-1 w-full" />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted">Padding</div>
              <div className="text-[11px] text-muted2">{padding}px</div>
            </div>
            <input type="range" min={0} max={Math.round(exportWidth * 0.1)} step={1} value={padding}
              onChange={(e) => onPaddingChange(Number(e.target.value))} className="mt-1 w-full" />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted">Border Radius</div>
              <div className="text-[11px] text-muted2">{borderRadius}px</div>
            </div>
            <input type="range" min={0} max={Math.round(exportWidth * 0.15)} step={1} value={borderRadius}
              onChange={(e) => onBorderRadiusChange(Number(e.target.value))} className="mt-1 w-full" />
          </div>

          <div>
            <div className="text-[11px] text-muted">Background</div>
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
                title="Custom color"
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

      <Section label="Export">
        <div className="flex flex-wrap gap-1">
          {[1080, 2048, 3000, 4096].map((w) => (
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
      </Section>
    </div>
  );
}
