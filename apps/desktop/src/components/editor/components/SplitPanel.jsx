// Seamless split tool panel: panel aspect presets, panel count stepper,
// coverage readout, the N-panel carousel preview, the output folder, and the
// export button. Presentational — EditorOverlay owns the state and passes the
// commit handlers (mirrors CropPanel).

import { useEffect, useRef } from "react";
import { Minus, Plus, Undo2, Redo2, RotateCcw, FolderOpen } from "lucide-react";
import { ASPECT_PRESETS } from "../cropMath";
import { SPLIT_ASPECT_KEYS, MIN_SPLIT_COUNT, MAX_SPLIT_COUNT, splitRectToPanels } from "../splitMath";
import { AspectButton } from "./CropPanel";

function FooterButton({ icon: Icon, label, onClick, disabled = false, primary = false, testId }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={[
        "inline-flex h-8 items-center rounded-md text-[11px] font-medium transition-colors disabled:cursor-default disabled:opacity-35",
        label ? "gap-1.5 px-3" : "w-8 justify-center",
        primary
          ? "bg-[rgb(var(--accent-color))] text-accentInk hover:brightness-110"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

// One panel of the carousel preview, drawn from the transformed preview raster.
function PanelThumb({ source, panel, index }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !source || !panel?.width || !panel?.height) return;
    const maxEdge = 160;
    const scale = Math.min(1, maxEdge / Math.max(panel.width, panel.height));
    canvas.width = Math.max(1, Math.round(panel.width * scale));
    canvas.height = Math.max(1, Math.round(panel.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, panel.x, panel.y, panel.width, panel.height, 0, 0, canvas.width, canvas.height);
  }, [source, panel?.x, panel?.y, panel?.width, panel?.height]);
  return (
    <div className="relative min-w-0 flex-1 overflow-hidden rounded-[4px] bg-app" style={{ aspectRatio: `${panel.width} / ${panel.height}` }}>
      <canvas ref={ref} className="block h-full w-full" />
      <span className="absolute left-1 top-1 text-[10px] font-semibold text-white drop-shadow">{index + 1}</span>
    </div>
  );
}

export default function SplitPanel({
  t,
  aspectKey, onCommitAspect,
  count, isAutoCount, onCommitCount,
  rect, previewSource, sourceDims,
  onResetRegion,
  outputDir, defaultOutputDir, onChooseFolder, onUseDefaultFolder,
  blockedReason,
  exporting, progress, onExport,
  onUndo, canUndo, onRedo, canRedo,
}) {
  const presets = SPLIT_ASPECT_KEYS.map((key) => ASPECT_PRESETS.find((p) => p.key === key)).filter(Boolean);
  const previewPanels = rect && previewSource
    ? splitRectToPanels(rect, count, previewSource.width, previewSource.height)
    : [];
  const outputPanels = rect && sourceDims?.width
    ? splitRectToPanels(rect, count, sourceDims.width, sourceDims.height)
    : [];
  const coverage = rect ? `${Math.round(rect.width * 100)}% × ${Math.round(rect.height * 100)}%` : "–";
  const panelSize = outputPanels[0] ? `${outputPanels[0].width} × ${outputPanels[0].height}` : "–";
  const folderName = (outputDir || defaultOutputDir || "").split(/[\\/]/).pop() || "";
  const canExport = !blockedReason && !exporting && !!rect && count >= MIN_SPLIT_COUNT;

  return (
    <>
      <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.panelAspect")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {presets.map((preset) => (
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
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.count")}</div>
          <div className="mt-3 flex items-center justify-between">
            <div className="inline-flex items-center overflow-hidden rounded-md bg-app">
              <button
                type="button"
                className="flex h-7 w-8 items-center justify-center text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-35"
                disabled={count <= MIN_SPLIT_COUNT}
                onClick={() => onCommitCount(count - 1)}
                aria-label={t("split.fewer")}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-8 text-center text-[12px] font-semibold tabular-nums text-text" data-testid="split-count">{count}</span>
              <button
                type="button"
                className="flex h-7 w-8 items-center justify-center text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-35"
                disabled={count >= MAX_SPLIT_COUNT}
                onClick={() => onCommitCount(count + 1)}
                aria-label={t("split.more")}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              className={[
                "rounded-md px-2 py-1 text-[11px] transition-colors",
                isAutoCount ? "bg-selected text-accent" : "text-muted hover:bg-hover hover:text-text",
              ].join(" ")}
              onClick={() => onCommitCount(null)}
            >
              {t("split.auto")}
            </button>
          </div>
        </div>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.coverage")}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted">
            <span>{t("split.region")}</span><span className="text-right text-text tabular-nums">{coverage}</span>
            <span>{t("split.panelOutput")}</span><span className="text-right text-text tabular-nums" data-testid="split-panel-size">{panelSize}</span>
          </div>
          <button type="button" className="mt-2 text-[11px] text-accent hover:underline" onClick={onResetRegion}>
            {t("split.resetRegion")}
          </button>
        </div>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.preview")}</div>
          <div className="mt-3 flex gap-1.5" data-testid="split-preview-strip">
            {previewPanels.map((panel, i) => (
              <PanelThumb key={i} source={previewSource} panel={panel} index={i} />
            ))}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.output")}</div>
          <div className="mt-2 truncate rounded-md bg-app px-2.5 py-2 text-[11px] text-muted" title={outputDir || defaultOutputDir || ""} data-testid="split-output-dir">
            {outputDir || defaultOutputDir || "–"}
          </div>
          <div className="mt-1.5 truncate text-[11px] text-muted2">
            {outputDir ? t("split.customFolder") : t("split.subfolderHint", { folder: folderName })}
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-3 whitespace-nowrap text-[11px]">
            {outputDir ? (
              <button type="button" className="text-accent hover:underline" onClick={onUseDefaultFolder}>{t("split.useDefaultFolder")}</button>
            ) : null}
            <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={onChooseFolder}>
              <FolderOpen className="h-3 w-3" />
              {t("split.chooseFolder")}
            </button>
          </div>
          {blockedReason ? (
            <div className="mt-3 rounded-md bg-app px-2.5 py-2 text-[11px] leading-snug text-muted" data-testid="split-blocked">{blockedReason}</div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <FooterButton icon={RotateCcw} label="" onClick={onResetRegion} />
        <FooterButton icon={Undo2} label="" onClick={onUndo} disabled={!canUndo} />
        <FooterButton icon={Redo2} label="" onClick={onRedo} disabled={!canRedo} />
        <div className="flex-1" />
        <FooterButton
          label={exporting && progress
            ? t("split.exporting", { done: progress.done, total: progress.total })
            : t("split.exportN", { count })}
          onClick={onExport}
          disabled={!canExport}
          primary
          testId="split-export"
        />
      </div>
    </>
  );
}
