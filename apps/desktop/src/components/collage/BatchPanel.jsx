import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getTemplatesForCount } from "./collageTemplates";
import { GROUP_SIZE_OPTIONS, MAX_TEMPLATE_COUNT } from "./collageBatch";
import { Section, TemplateGrid, CanvasSection, ExportWidthChips, ImagesSection } from "./PanelControls";

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={[
        "rounded-md px-2.5 py-1 text-[11px] transition-colors",
        active ? "bg-selected text-text" : "bg-app text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function BatchPanel({
  imageCount,
  groups,
  groupSize,
  onGroupSizeChange,
  orderBy,
  onOrderByChange,
  remainderMode,
  onRemainderModeChange,
  templateId,
  onTemplateIdChange,
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
  namePrefix,
  onNamePrefixChange,
  images,
  onRemoveImage,
  onAddImages,
}) {
  const { t } = useTranslation("collage");
  const [customSize, setCustomSize] = useState("");

  const templates = getTemplatesForCount(groupSize);
  const remainder = imageCount % groupSize;
  const isCustomSize = !GROUP_SIZE_OPTIONS.includes(groupSize);

  function applyCustomSize(raw) {
    setCustomSize(raw);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 2 && n <= MAX_TEMPLATE_COUNT) onGroupSizeChange(n);
  }

  const nameExample = `${namePrefix || "collage"}_01.jpg`;

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="batch-panel">
      {/* Same section order as single mode: Images → Layout → (Grouping) → Canvas → Export */}
      <ImagesSection
        images={images}
        onRemove={(item) => onRemoveImage(item)}
        onAdd={onAddImages}
      />

      {/* Layout for every page. Per-page tweaks live on the page cards. */}
      <Section label={t("layout")}>
        <TemplateGrid
          templates={templates}
          activeId={templateId}
          ratio={canvasRatio || 1}
          onSelect={(tmpl) => onTemplateIdChange(tmpl.id)}
        />
      </Section>

      {/* Grouping */}
      <Section label={t("grouping")}>
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-muted">{t("perCollage")}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {GROUP_SIZE_OPTIONS.map((n) => (
                <Chip
                  key={n}
                  active={groupSize === n}
                  onClick={() => { onGroupSizeChange(n); setCustomSize(""); }}
                >
                  {t("nImages", { n })}
                </Chip>
              ))}
              <input
                type="number"
                min={2}
                max={MAX_TEMPLATE_COUNT}
                placeholder="12"
                value={customSize}
                onChange={(e) => applyCustomSize(e.target.value)}
                className={[
                  "w-12 rounded-md px-2 py-1 text-center text-[11px] outline-none border transition-colors",
                  isCustomSize
                    ? "bg-selected text-text border-[rgb(var(--accent-color)/0.5)]"
                    : "bg-app text-muted border-border/40 focus:border-[rgb(var(--accent-color)/0.5)]",
                ].join(" ")}
              />
            </div>
          </div>

          <div>
            <div className="text-[11px] text-muted">{t("imageOrder")}</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[
                { id: "selection", label: t("orderSelection") },
                { id: "captureTime", label: t("orderCaptureTime") },
                { id: "filename", label: t("orderFilename") },
              ].map((opt) => (
                <Chip key={opt.id} active={orderBy === opt.id} onClick={() => onOrderByChange(opt.id)}>
                  {opt.label}
                </Chip>
              ))}
            </div>
          </div>

          {remainder > 0 && (
            <div>
              <div className="text-[11px] text-muted">{t("remainderHandling")}</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[
                  { id: "own", label: t("remainderOwn") },
                  { id: "merge", label: t("remainderMerge") },
                  { id: "drop", label: t("remainderDrop") },
                ].map((opt) => (
                  <Chip key={opt.id} active={remainderMode === opt.id} onClick={() => onRemainderModeChange(opt.id)}>
                    {opt.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
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
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-muted">{t("exportWidth")}</div>
            <div className="mt-1.5">
              <ExportWidthChips exportWidth={exportWidth} onExportWidthChange={onExportWidthChange} />
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted">{t("fileNaming")}</div>
            <input
              type="text"
              value={namePrefix}
              onChange={(e) => onNamePrefixChange(e.target.value)}
              placeholder="collage"
              className="mt-1.5 w-full rounded-md bg-app px-2 py-1.5 text-[11px] text-text outline-none border border-border/40 focus:border-[rgb(var(--accent-color)/0.5)]"
            />
            <div className="mt-1.5 text-[10px] tabular-nums text-muted2">
              {t("namingPreview", { example: nameExample, count: groups.length })}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
