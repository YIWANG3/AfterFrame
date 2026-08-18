import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, Crosshair, RotateCcw, Minus } from "lucide-react";
import { getTemplatesForCount } from "./collageTemplates";
import { PanelLabel, Section, TemplateGrid, CanvasSection, ExportWidthChips, ImagesSection } from "./PanelControls";

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
  selectedCellIdx = -1,
  selectedCellZoom = 1,
  onSelectedZoomChange,
  onCenterSelected,
  onResetSelected,
  onDeselect,
}) {
  const { t } = useTranslation("collage");
  const templates = useMemo(() => getTemplatesForCount(images.length), [images.length]);

  function removeImage(index) {
    const next = images.filter((_, i) => i !== index);
    onImagesChange(next);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <ImagesSection
        images={images}
        onRemove={(_item, i) => removeImage(i)}
        onAdd={onAddImages}
      />

      {selectedCellIdx >= 0 && (
        <div className="border-b border-border/60 bg-app/40 px-4 py-3">
          <div className="flex items-center justify-between">
            <PanelLabel>{t("cell", { n: selectedCellIdx + 1 })}</PanelLabel>
            <button
              type="button"
              className="rounded p-0.5 text-muted2 hover:bg-hover hover:text-text"
              onClick={onDeselect}
              title={t("deselect")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted">{t("zoom")}</div>
              <div className="text-[11px] tabular-nums text-muted2">{selectedCellZoom.toFixed(2)}×</div>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <button
                type="button"
                title={t("zoomOut")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-text"
                onClick={() => onSelectedZoomChange?.(Math.max(0.5, selectedCellZoom / 1.05))}
              >
                <Minus className="h-3 w-3" />
              </button>
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.01}
                value={selectedCellZoom}
                onChange={(e) => onSelectedZoomChange?.(Number(e.target.value))}
                className="min-w-0 flex-1 accent-[rgb(var(--accent-color))]"
              />
              <button
                type="button"
                title={t("zoomIn")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-text"
                onClick={() => onSelectedZoomChange?.(Math.min(5, selectedCellZoom * 1.05))}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="mt-3 flex gap-1.5">
            <button
              type="button"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-app py-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
              onClick={onCenterSelected}
              title={t("centerInCell")}
            >
              <Crosshair className="h-3 w-3" />
              Center
            </button>
            <button
              type="button"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-app py-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
              onClick={onResetSelected}
              title={t("resetPosZoom")}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>
          <div className="mt-2 text-[10px] leading-relaxed text-muted2">
            {t("panHint")}
          </div>
        </div>
      )}

      <Section label={t("layout")}>
        <TemplateGrid
          templates={templates}
          activeId={template?.id}
          ratio={canvasRatio || 1}
          onSelect={onTemplateChange}
        />
      </Section>

      <CanvasSection
        canvasRatio={canvasRatio}
        onCanvasRatioChange={onCanvasRatioChange}
        gap={gap}
        onGapChange={onGapChange}
        padding={padding}
        onPaddingChange={onPaddingChange}
        borderRadius={borderRadius}
        onBorderRadiusChange={onBorderRadiusChange}
        bgColor={bgColor}
        onBgColorChange={onBgColorChange}
        exportWidth={exportWidth}
      />

      <Section label={t("export")}>
        <ExportWidthChips exportWidth={exportWidth} onExportWidthChange={onExportWidthChange} />
      </Section>
    </div>
  );
}
