// Seamless split tool panel: panel aspect presets, panel count stepper,
// coverage readout, the N-panel carousel preview, the output folder, and the
// export button. Presentational — EditorOverlay owns the state and passes the
// commit handlers (mirrors CropPanel).

import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Undo2, Redo2, RotateCcw, FolderOpen } from "lucide-react";
import { ASPECT_PRESETS } from "../cropMath";
import {
  SPLIT_ASPECT_KEYS, CUSTOM_SPLIT_ASPECT_KEY, MIN_SPLIT_COUNT, MAX_SPLIT_COUNT,
  MIN_CUSTOM_ASPECT_SIDE, MAX_CUSTOM_ASPECT_SIDE, isValidCustomAspect, splitRectToPanels,
} from "../splitMath";
import { AspectButton } from "./CropPanel";
import api from "../../../api";

// Long paths keep their head and tail (the folder name is what matters).
function middleEllipsis(text, max = 40) {
  if (!text || text.length <= max) return text || "";
  const tail = Math.floor(max * 0.55);
  const head = max - tail - 1;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

// "Custom" tile — the sixth cell of the ratio grid: dashed preview box (like
// the crop tool's Free) plus two inline W:H inputs, styled like the collage
// panel's ratio inputs. Typing applies immediately once both sides are valid;
// focusing an input selects the tile.
function CustomAspectTile({ t, active, custom, onCommit }) {
  const [draft, setDraft] = useState({ width: String(custom.width), height: String(custom.height) });
  useEffect(() => { setDraft({ width: String(custom.width), height: String(custom.height) }); }, [custom.width, custom.height]);
  const aspect = isValidCustomAspect(custom) ? custom.width / custom.height : 3 / 4;
  const max = 14;
  const box = aspect >= 1
    ? { width: max, height: Math.max(6, Math.round(max / aspect)) }
    : { width: Math.max(6, Math.round(max * aspect)), height: max };
  const change = (key, raw) => {
    const nextDraft = { ...draft, [key]: raw };
    setDraft(nextDraft);
    const next = { width: Number(nextDraft.width), height: Number(nextDraft.height) };
    if (isValidCustomAspect(next)) onCommit(next);
  };
  const field = (key, label) => (
    <input
      type="number"
      min={MIN_CUSTOM_ASPECT_SIDE}
      max={MAX_CUSTOM_ASPECT_SIDE}
      step="any"
      value={draft[key]}
      aria-label={label}
      data-testid={`split-custom-${key}`}
      onFocus={() => { if (!active) onCommit(isValidCustomAspect(custom) ? custom : { width: 3, height: 4 }); }}
      onChange={(e) => change(key, e.target.value)}
      onBlur={() => setDraft({ width: String(custom.width), height: String(custom.height) })}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      // Plain grey pill, no focus ring or shadow (unlike the collage input).
      className="h-6 w-10 rounded-full border-0 px-1 text-center text-[11px] tabular-nums text-text shadow-none outline-none focus:outline-none focus-visible:outline-none"
      style={{ background: "var(--fill)" }}
    />
  );
  return (
    <div
      className={[
        "flex items-center gap-2 rounded-md px-2.5 py-1 text-[11px] transition-colors",
        active ? "bg-selected text-accent" : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      data-testid="split-aspect-custom"
      title={t("split.custom")}
    >
      <span className="flex h-4 w-4 items-center justify-center shrink-0">
        <span
          className="block border border-current opacity-70"
          style={{ width: `${box.width}px`, height: `${box.height}px`, borderStyle: "dashed", borderRadius: "1.5px" }}
        />
      </span>
      <span className="flex items-center gap-1">
        {field("width", t("split.customWidth"))}
        <span className="text-muted2">:</span>
        {field("height", t("split.customHeight"))}
      </span>
    </div>
  );
}

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
    <div className="relative h-full min-w-0 shrink overflow-hidden rounded-[4px] bg-app" style={{ aspectRatio: `${panel.width} / ${panel.height}` }}>
      <canvas ref={ref} className="block h-full w-full" />
      <span className="absolute left-1 top-1 text-[10px] font-semibold text-white drop-shadow">{index + 1}</span>
    </div>
  );
}

export default function SplitPanel({
  t,
  aspectKey, customAspect, onCommitAspect,
  count, isAutoCount, onCommitCount,
  rect, previewSource, sourceDims,
  onResetRegion,
  outputDir, subfolder, onSubfolderChange, onChooseFolder,
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
  const canExport = !blockedReason && !exporting && !!rect && count >= MIN_SPLIT_COUNT;
  // The web bridge has no file system: panels arrive as browser downloads.
  const hasFileSystem = api.can("fileSystem");

  return (
    <>
      <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
        <div className="border-b border-border/60 px-4 py-3">
          {/* Same heading and tile style as the crop tool's Aspect Ratio; the
              ratios here are PER PANEL and vertical-only, plus a Custom tile. */}
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("overlay.aspectRatio")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {presets.map((preset) => (
              <AspectButton
                key={preset.key}
                preset={preset}
                active={aspectKey === preset.key}
                onClick={() => onCommitAspect(preset.key)}
              />
            ))}
            <CustomAspectTile
              t={t}
              active={aspectKey === CUSTOM_SPLIT_ASPECT_KEY}
              custom={customAspect}
              onCommit={(next) => onCommitAspect(CUSTOM_SPLIT_ASPECT_KEY, next)}
            />
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
          <button type="button" className="mt-1 text-[11px] text-accent hover:underline" onClick={onResetRegion}>
            {t("split.resetRegion")}
          </button>
        </div>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.preview")}</div>
          <div className="mt-2 flex h-16 gap-1.5" data-testid="split-preview-strip">
            {previewPanels.map((panel, i) => (
              <PanelThumb key={i} source={previewSource} panel={panel} index={i} />
            ))}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("split.output")}</div>
          {hasFileSystem ? (
            <>
              <div className="mt-2 flex items-center gap-1.5">
                <div
                  className="min-w-0 flex-1 whitespace-nowrap rounded-md bg-app px-2.5 py-2 text-[11px] text-muted"
                  title={outputDir || ""}
                  data-testid="split-output-dir"
                  data-path={outputDir || ""}
                >
                  {middleEllipsis(outputDir, 36) || "–"}
                </div>
                <button
                  type="button"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-app text-muted transition-colors hover:bg-hover hover:text-text"
                  onClick={onChooseFolder}
                  title={t("split.chooseFolder")}
                  aria-label={t("split.chooseFolder")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={subfolder}
                  onChange={(e) => onSubfolderChange(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[rgb(var(--accent-color))]"
                  data-testid="split-subfolder"
                />
                {t("split.subfolder")}
              </label>
            </>
          ) : (
            <div className="mt-2 rounded-md bg-app px-2.5 py-2 text-[11px] leading-snug text-muted" data-testid="split-web-hint">
              {t("split.webDownloads", { count })}
            </div>
          )}
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
