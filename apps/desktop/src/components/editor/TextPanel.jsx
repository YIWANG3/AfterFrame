import api from "../../api";
import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import ColorPickerPopover from "../collage/ColorPickerPopover";

function hexToRgba(hex, alpha = 1) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

import {
  Plus, Trash2, Type,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Columns2, Rows2, ChevronDown, Check, Undo2, Redo2, RotateCcw, Link, Unlink, Layers, Sparkles, GripVertical, FolderOpen, RotateCw, Cannabis, Image as ImageIcon, X, Brush, Blend,
  PanelTop, PanelBottom, PanelLeft, PanelRight,
} from "lucide-react";
import HandwritingModal from "./handwriting/HandwritingModal";
import { handwritingAlphaFromUrl, colorizeHandwriting } from "./render/handwritingMatte";
import { localFileUrl as mediaUrlFor } from "../../utils/format";

import { SliderRow, NumberDragInput as NumInput } from "../../ui";
import { gradientToCss, normalizeScrim, OVERLAY_EDGES } from "./render/canvasHelpers";
import BorderControls from "./components/BorderControls";
import { isTextLayer, isStickerLayer, isOverlayLayer, layerLabel } from "./layerStack";
import {
  FONT_OPTIONS, COLOR_SWATCHES, PRESETS,
  createDefaultLayer, createStickerLayer, createOverlayLayer, applyPreset, cloneLayers, getBgPadding,
} from "./textState";
import {
  alignLeft, alignCenterH, alignRight,
  alignTop, alignCenterV, alignBottom,
  distributeH, distributeV,
} from "./textAlign";

export default function TextPanel({
  layers = [],
  selectedIds = new Set(),
  onLayersChange,
  onLayersCoalesced,
  onSelectionChange,
  onApply,
  onReset,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onMoveLayer,
  onDeleteLayer,
  // Scene depth (single ML inference per image)
  hasSceneDepth = false,
  depthGenerating = false,
  depthError = null,
  onComputeDepth,
  onClearDepth,
  depthFeather = 0.08,
  onDepthFeatherChange,
  depthMapVisible = false,
  onToggleDepthMap,
  depthModel = null,
  onPickDepthModel,
  onResetDepthModel,
  // Border / frame — presets + canvas margins (no separate frame tool).
  framePresets = [],
  frameThumbs,
  frameCellAspect,
  onApplyPreset,
  onClearPreset,
  canvasPad,
  onCanvasPad,
  onCanvasPadCommit,
  canvasBg,
  onCanvasBg,
}) {
  const { t } = useTranslation("editor");
  const selected = layers.filter((l) => selectedIds.has(l.id));
  const selectedText = selected.filter(isTextLayer);
  const current = selected.length === 1 ? selected[0] : null;
  const currentIsText = isTextLayer(current);
  const currentIsSticker = isStickerLayer(current);
  const currentIsOverlay = isOverlayLayer(current);
  // Inspector always shows text controls when applicable. If no text is selected
  // and no sticker is selected, fall back to the topmost text layer so the panel
  // layout never collapses (avoids jumpy UX).
  const editTarget = currentIsText
    ? current
    : ((currentIsSticker || currentIsOverlay) ? null : (layers.filter(isTextLayer).slice(-1)[0] || null));

  // Style edits (sliders, scrubbers, toggles, typing) apply live and coalesce
  // into ONE undo step per gesture — a run of same-target/same-field edits is
  // debounced together, keyed by this signature. Discrete structural ops
  // (add/delete/reorder/align) use onLayersChange directly for an immediate step.
  const update = useCallback((id, patch) => {
    const next = layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
    if (onLayersCoalesced) onLayersCoalesced(next, `${id}|${Object.keys(patch).sort().join(",")}`);
    else onLayersChange(next);
  }, [layers, onLayersChange, onLayersCoalesced]);

  const [vPadLinked, setVPadLinked] = useState(true);
  const [hPadLinked, setHPadLinked] = useState(true);
  useEffect(() => {
    if (!current) return;
    const pad = getBgPadding(current);
    setVPadLinked(pad.top === pad.bottom);
    setHPadLinked(pad.left === pad.right);
  }, [current?.id]);

  const addLayer = () => {
    const nl = createDefaultLayer();
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
  };

  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [handwritingOpen, setHandwritingOpen] = useState(false);
  const [presetsExpanded, setPresetsExpanded] = useState(false);
  const addOverlayLayer = () => {
    const nl = createOverlayLayer({ sourceLabel: t("text.overlayLayer") });
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
  };
  const handleAddHandwriting = ({ stickerPath, naturalWidth, naturalHeight, sourceLabel, handwriting }) => {
    const nl = createStickerLayer(
      { stickerPath, naturalWidth, naturalHeight, sourceLabel },
      { handwriting }
    );
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
    setHandwritingOpen(false);
  };
  const handleAddSticker = (sticker) => {
    const nl = createStickerLayer({
      stickerPath: sticker.path,
      naturalWidth: sticker.width,
      naturalHeight: sticker.height,
      sourceLabel: sticker.name || sticker.sourceLabel,
    });
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
    setStickerPickerOpen(false);
  };

  const deleteLayer = (id) => {
    onLayersChange(layers.filter((l) => l.id !== id));
    const next = new Set(selectedIds);
    next.delete(id);
    onSelectionChange(next);
  };

  const selectLayer = (id, e) => {
    if (e.shiftKey) {
      const next = new Set(selectedIds);
      next.has(id) ? next.delete(id) : next.add(id);
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([id]));
    }
  };

  return (
    <>
      <div className="relative h-[calc(100vh-10rem)]">
      <div className="h-full overflow-y-auto">
        {/* Presets — compact horizontal strip like the frame presets; the
            chevron expands to the full grid. */}
        <Section label={t("text.presets")} action={
          <button
            type="button"
            title={presetsExpanded ? t("border.collapse") : t("border.expand")}
            onClick={() => setPresetsExpanded((v) => !v)}
            className="flex h-5 w-5 items-center justify-center rounded text-muted2 hover:bg-hover hover:text-text"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${presetsExpanded ? "rotate-180" : ""}`} />
          </button>
        }>
          {(() => {
            const chip = (p) => (
              <button
                key={p.name}
                type="button"
                className={[
                  "flex w-full flex-col items-center gap-1 rounded-md border px-1 py-2 transition-colors",
                  current?.preset === p.name
                    ? "border-[rgb(var(--accent-color))] bg-[rgb(var(--accent-color)/0.08)]"
                    : "border-border/60 bg-app hover:border-border hover:bg-hover",
                ].join(" ")}
                onClick={() => {
                  if (current) {
                    // Apply preset to selected layer
                    update(current.id, { ...p.style, preset: p.name });
                  } else {
                    // No selection — create new layer
                    const nl = createDefaultLayer({ text: "New Title" });
                    const styled = applyPreset(nl, p);
                    onLayersChange([...layers, styled]);
                    onSelectionChange(new Set([styled.id]));
                  }
                }}
              >
                <PresetPreview preset={p} />
                <span className={[
                  "text-[9px] whitespace-nowrap",
                  current?.preset === p.name ? "text-[rgb(var(--accent-color))]" : "text-muted2",
                ].join(" ")}>{p.name}</span>
              </button>
            );
            return presetsExpanded ? (
              <div className="grid grid-cols-4 gap-1.5">{PRESETS.map(chip)}</div>
            ) : (
              // Compact strip: scroll horizontally; scrollbar hidden (drag/wheel to scroll).
              <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {PRESETS.map((p) => (
                  <div key={p.name} className="w-[23%] shrink-0">{chip(p)}</div>
                ))}
              </div>
            );
          })()}
        </Section>

        {/* Border / frame — presets that drop text+logo layers + margins, plus
            manual canvas margins & background. Replaces the standalone frame tool. */}
        {onCanvasPad ? (
          <Section label={t("border.title")}>
            <BorderControls
              templates={framePresets}
              thumbs={frameThumbs}
              cellAspect={frameCellAspect}
              onApplyPreset={onApplyPreset}
              onClearPreset={onClearPreset}
              pad={canvasPad}
              onPad={onCanvasPad}
              onPadCommit={onCanvasPadCommit}
              bg={canvasBg}
              onBg={onCanvasBg}
            />
          </Section>
        ) : null}

        {/* Scene depth — image-level metadata. One ML inference per image; results
            cached and shared by every text layer's z position slider. */}
        <Section label={t("text.depth.title")} action={
          hasSceneDepth ? (
            <button
              type="button"
              onClick={onClearDepth}
              className="text-[10px] text-muted2 hover:text-text"
            >
              {t("text.clear")}
            </button>
          ) : null
        }>
          {depthError && (
            <div className="mb-2 rounded-md bg-[rgb(var(--error-color)/0.08)] px-2 py-1 text-[10px] text-[rgb(var(--error-color))]">
              {depthError}
            </div>
          )}
          <button
            type="button"
            onClick={() => onComputeDepth?.({ force: hasSceneDepth })}
            disabled={depthGenerating || !onComputeDepth}
            className={[
              "flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors",
              hasSceneDepth
                ? "border-[rgb(var(--accent-color)/0.4)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
                : "border-border/60 bg-app text-text hover:border-border hover:bg-hover",
              "disabled:opacity-60 disabled:pointer-events-none",
            ].join(" ")}
          >
            {depthGenerating ? (
              <><Layers className="h-3.5 w-3.5 animate-pulse" /> {t("text.depth.inferring")}</>
            ) : hasSceneDepth ? (
              <><Layers className="h-3.5 w-3.5" /> {t("text.depth.ready")}</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5" /> {t("text.depth.generate")}</>
            )}
          </button>
          {hasSceneDepth && (
            <>
              <SliderRow
                label={t("text.soft")}
                min={0}
                max={30}
                value={Math.round(depthFeather * 100)}
                onChange={(v) => onDepthFeatherChange?.(v / 100)}
                suffix="%"
              />
              {editTarget && (
                <SliderRow
                  label={t("text.position")}
                  min={0}
                  max={100}
                  value={Math.round(((editTarget.zPosition ?? 1) * 100))}
                  onChange={(v) => update(editTarget.id, { zPosition: v / 100 })}
                  suffix="%"
                />
              )}
              <label className="mt-1.5 flex items-center gap-2 text-[10px] text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={depthMapVisible}
                  onChange={(e) => onToggleDepthMap?.(e.target.checked)}
                  className="accent-[rgb(var(--accent-color))]"
                />
                {t("text.depth.showMap")}
              </label>
            </>
          )}
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted2">
              <span className="uppercase tracking-wide">{t("text.depth.model")}</span>
              {depthModel?.isCustom && (
                <button
                  type="button"
                  onClick={() => onResetDepthModel?.()}
                  className="text-[10px] text-muted2 hover:text-text"
                  title={t("text.depth.useBundled")}
                >
                  {t("text.reset")}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onPickDepthModel?.()}
              className="flex h-7 w-full items-center gap-2 rounded-md border border-border/60 bg-app px-2 text-[11px] text-text transition-colors hover:border-border hover:bg-hover"
              title={depthModel?.path || t("text.depth.selectModel")}
            >
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted2" />
              <span className="truncate flex-1 text-left">
                {depthModel?.name || t("text.depth.default")}
              </span>
              <span className="text-[9px] text-muted2 flex-shrink-0">
                {depthModel?.isCustom ? t("text.depth.custom") : t("text.depth.bundled")}
              </span>
            </button>
          </div>
        </Section>

        {/* Layers — overlay + text + sticker */}
        <Section label={t("text.layers")} action={
          <div className="flex items-center gap-0.5">
            <IconBtn
              icon={Blend}
              title={t("text.addOverlayLayer")}
              onClick={addOverlayLayer}
            />
            <IconBtn
              icon={Brush}
              title={t("text.addHandwriting")}
              onClick={() => setHandwritingOpen(true)}
            />
            <IconBtn
              icon={Cannabis}
              title={stickerPickerOpen ? t("text.hideStickerPicker") : t("text.addStickerLayer")}
              onClick={() => setStickerPickerOpen((v) => !v)}
            />
            <IconBtn icon={Type} title={t("text.addTextLayer")} onClick={addLayer} />
          </div>
        }>
          <LayerList
            layers={layers}
            selectedIds={selectedIds}
            onSelect={selectLayer}
            onLayersChange={onLayersChange}
            onDelete={(id) => (onDeleteLayer || deleteLayer)(id)}
          />
          {selectedText.length >= 2 && <AlignBar layers={selectedText} onLayersChange={onLayersChange} allLayers={layers} />}
        </Section>

        {currentIsSticker && current && (
          <StickerLayerInspector
            layer={current}
            update={update}
            hasSceneDepth={hasSceneDepth}
          />
        )}

        {currentIsOverlay && current && (
          <OverlayLayerInspector layer={current} update={update} />
        )}

        {editTarget && (() => {
          // Alias so the rest of the inspector keeps reading `current` —
          // when no text layer is selected, this transparently edits the
          // topmost text layer instead of collapsing the panel.
          const current = editTarget;
          return (
          <>
            {/* Content */}
            <Section label={t("text.content")}>
              <textarea
                className="w-full resize-y rounded-md border border-border/60 bg-app px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none transition-colors placeholder:text-muted2 focus:border-[rgb(var(--accent-color))]"
                rows={2}
                value={current.text}
                onChange={(e) => update(current.id, { text: e.target.value })}
                placeholder={t("text.enterText")}
              />
            </Section>


            {/* Font */}
            <Section label={t("text.font")}>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <FontSelect value={current.fontFamily} onChange={(f) => update(current.id, { fontFamily: f })} />
                </div>
                <div className="flex w-24 flex-none">
                  <WeightSelect value={current.fontWeight ?? (current.bold ? 700 : 400)} onChange={(w) => update(current.id, { fontWeight: w, bold: w >= 600 })} />
                </div>
              </div>
              {/* Decoration + case toggles — one segmented row; case cells
                  toggle off when the active one is clicked again. */}
              <SegGroup
                className="mt-1.5"
                options={[
                  { key: "italic", label: <span className="italic">I</span>, active: current.italic, onClick: () => update(current.id, { italic: !current.italic }) },
                  { key: "underline", label: <span className="underline">U</span>, title: t("text.underline"), active: current.underline, onClick: () => update(current.id, { underline: !current.underline }) },
                  { key: "strike", label: <span className="line-through">S</span>, title: t("text.strikethrough"), active: current.strikethrough, onClick: () => update(current.id, { strikethrough: !current.strikethrough }) },
                  ...[["upper", "AA", t("text.caseUpper")], ["lower", "aa", t("text.caseLower")], ["title", "Aa", t("text.caseTitle")]].map(([mode, label, title]) => ({
                    key: mode, label, title,
                    active: (current.textCase ?? "none") === mode,
                    onClick: () => update(current.id, { textCase: (current.textCase ?? "none") === mode ? "none" : mode }),
                  })),
                ]}
              />
              {/* Numeric fields, Sketch-style: drag horizontally to scrub,
                  click to type. Label sits under the value. */}
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                <FieldCell label={t("text.size")} value={current.fontSize} min={8} max={2000} onChange={(v) => update(current.id, { fontSize: v })} />
                <FieldCell label={t("text.letterSpacing")} value={Math.round((current.tracking ?? 0) * 100)} min={-10} max={200} onChange={(v) => update(current.id, { tracking: v / 100 })} />
                <FieldCell label={t("text.lineHeight")} value={Math.round((current.lineHeight ?? 1.2) * 100)} min={80} max={250} onChange={(v) => update(current.id, { lineHeight: v / 100 })} />
              </div>
            </Section>

            {/* Fill */}
            <Section label={t("text.fill")}>
              <PaintRow
                paint={paintFromFields(current, "fill")}
                availableModes={["solid", "gradient"]}
                onUpdate={(patch) => update(current.id, paintToFields(patch, "fill"))}
                opacityValue={current.opacity}
                onOpacityChange={(v) => update(current.id, { opacity: v })}
              />
            </Section>

            {/* Stroke */}
            <Section label={t("text.stroke")} right={<Switch on={current.strokeEnabled} onToggle={() => update(current.id, { strokeEnabled: !current.strokeEnabled })} />}>
              {current.strokeEnabled && (
                <StrokeFieldRow
                  paint={paintFromFields(current, "stroke")}
                  availableModes={["solid", "gradient"]}
                  onPaintUpdate={(patch) => update(current.id, paintToFields(patch, "stroke"))}
                  width={current.strokeWidth}
                  maxWidth={50}
                  onWidthChange={(v) => update(current.id, { strokeWidth: v })}
                />
              )}
            </Section>

            {/* Background */}
            <Section label={t("text.background")} right={<Switch on={current.bgMode !== "none"} onToggle={() => update(current.id, { bgMode: current.bgMode !== "none" ? "none" : "solid" })} />}>
              {current.bgMode !== "none" && (
                <>
                  <PaintRow
                    paint={paintFromFields(current, "bg")}
                    availableModes={["solid", "gradient"]}
                    onUpdate={(patch) => update(current.id, paintToFields(patch, "bg"))}
                    opacityValue={current.bgOpacity}
                    onOpacityChange={(v) => update(current.id, { bgOpacity: v })}
                  />
                  {(() => {
                    const pad = getBgPadding(current);
                    const setTop = (v) => update(current.id, vPadLinked ? { bgPadTop: v, bgPadBottom: v } : { bgPadTop: v });
                    const setBottom = (v) => update(current.id, vPadLinked ? { bgPadTop: v, bgPadBottom: v } : { bgPadBottom: v });
                    const setLeft = (v) => update(current.id, hPadLinked ? { bgPadLeft: v, bgPadRight: v } : { bgPadLeft: v });
                    const setRight = (v) => update(current.id, hPadLinked ? { bgPadLeft: v, bgPadRight: v } : { bgPadRight: v });
                    const toggleV = () => {
                      const next = !vPadLinked;
                      setVPadLinked(next);
                      if (next && pad.top !== pad.bottom) update(current.id, { bgPadBottom: pad.top });
                    };
                    const toggleH = () => {
                      const next = !hPadLinked;
                      setHPadLinked(next);
                      if (next && pad.left !== pad.right) update(current.id, { bgPadRight: pad.left });
                    };
                    return (
                      <div className="mt-2">
                        <div className="mb-1 text-[10px] text-muted2">{t("text.padding")}</div>
                        <div className="flex items-stretch gap-3">
                          <PairedFields
                            leftLabel="T" leftValue={pad.top} onLeftChange={setTop}
                            rightLabel="B" rightValue={pad.bottom} onRightChange={setBottom}
                            min={-50} max={80}
                            linked={vPadLinked} onToggleLink={toggleV}
                            linkTitle={vPadLinked ? t("text.unlinkTopBottom") : t("text.linkTopBottom")}
                          />
                          <PairedFields
                            leftLabel="L" leftValue={pad.left} onLeftChange={setLeft}
                            rightLabel="R" rightValue={pad.right} onRightChange={setRight}
                            min={-50} max={80}
                            linked={hPadLinked} onToggleLink={toggleH}
                            linkTitle={hPadLinked ? t("text.unlinkLeftRight") : t("text.linkLeftRight")}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </Section>

            {/* Shadow */}
            <Section label={t("text.shadow")} right={<Switch on={current.shadow} onToggle={() => update(current.id, { shadow: !current.shadow })} />}>
              {current.shadow && (
                <ShadowFieldRow layer={current} onChange={(patch) => update(current.id, patch)} />
              )}
            </Section>

            <GlowSection layer={current} update={update} />
          </>
          );
        })()}
      </div>
      {stickerPickerOpen && (
        <StickerPickerModal
          onPick={(s) => handleAddSticker(s)}
          onClose={() => setStickerPickerOpen(false)}
        />
      )}
      {handwritingOpen && (
        <HandwritingModal
          onAdd={handleAddHandwriting}
          onClose={() => setHandwritingOpen(false)}
        />
      )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <FooterBtn icon={RotateCcw} label={t("text.reset")} onClick={onReset} />
        <FooterBtn icon={Undo2} onClick={onUndo} disabled={!canUndo} />
        <FooterBtn icon={Redo2} onClick={onRedo} disabled={!canRedo} />
        <button
          type="button"
          className="ml-auto flex h-[30px] items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color))] px-4 text-[11px] font-semibold text-[#111] transition-all hover:brightness-110"
          onClick={onApply}
        >
          <Check className="h-3.5 w-3.5" /> Apply
        </button>
      </div>
    </>
  );
}

/* ── Sub-components ─────────────────────────────── */

function Section({ label, action, right, children }) {
  return (
    <div className="border-b border-border/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{label}</span>
        {action || right || null}
      </div>
      {children}
    </div>
  );
}

function LayerList({ layers, selectedIds, onSelect, onLayersChange, onDelete }) {
  const { t } = useTranslation("editor");
  const dragSrcIdRef = useRef(null);
  const [overInfo, setOverInfo] = useState(null); // { id, position: 'above'|'below' } in display order

  if (layers.length === 0) {
    return null;
  }

  // Display top-to-bottom = visual stack top-to-bottom (highest zIndex first).
  // The underlying array's last element is the topmost layer, so reverse for display.
  const display = [...layers].reverse();

  function startDrag(e, id) {
    dragSrcIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
    // Safety net: window-level cleanup in case dragend / drop is swallowed.
    const cleanup = () => {
      dragSrcIdRef.current = null;
      setOverInfo(null);
      window.removeEventListener("mouseup", cleanup);
      window.removeEventListener("dragend", cleanup);
      window.removeEventListener("drop", cleanup);
    };
    window.addEventListener("mouseup", cleanup);
    window.addEventListener("dragend", cleanup);
    window.addEventListener("drop", cleanup);
  }
  function onDragOver(e, id) {
    if (!dragSrcIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setOverInfo((prev) => (prev?.id === id && prev?.position === position ? prev : { id, position }));
  }
  function endDrag() {
    dragSrcIdRef.current = null;
    setOverInfo(null);
  }
  function onDrop(e, targetId) {
    e.preventDefault();
    const sourceId = dragSrcIdRef.current;
    setOverInfo(null);
    dragSrcIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;
    const sourceIdx = layers.findIndex((l) => l.id === sourceId);
    const targetIdx = layers.findIndex((l) => l.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = layers.slice();
    const [moved] = next.splice(sourceIdx, 1);
    const newTargetIdx = next.findIndex((l) => l.id === targetId);
    // In DISPLAY order (reversed), "above" target is visually above; in array, above-display = HIGHER array index.
    const insertIdx = overInfo?.position === "above" ? newTargetIdx + 1 : newTargetIdx;
    next.splice(insertIdx, 0, moved);
    onLayersChange(next);
  }

  return (
    <div className="flex flex-col gap-0.5">
      {display.map((l) => {
        const isSelected = selectedIds.has(l.id);
        const TypeIcon = isOverlayLayer(l) ? Blend : (isStickerLayer(l) ? Cannabis : Type);
        const showLineAbove = overInfo?.id === l.id && overInfo.position === "above";
        const showLineBelow = overInfo?.id === l.id && overInfo.position === "below";
        return (
          <div key={l.id} className="relative">
            {showLineAbove && <div className="pointer-events-none absolute left-2 right-2 top-0 h-0.5 bg-[rgb(var(--accent-color))]" />}
            <div
              draggable={true}
              onDragStart={(e) => startDrag(e, l.id)}
              onDragEnd={endDrag}
              onDragOver={(e) => onDragOver(e, l.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setOverInfo((prev) => (prev?.id === l.id ? null : prev));
              }}
              onDrop={(e) => onDrop(e, l.id)}
              style={{ cursor: "grab" }}
              className={[
                "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors active:cursor-grabbing",
                isSelected ? "bg-[rgb(var(--accent-color)/0.06)]" : "hover:bg-hover",
              ].join(" ")}
              onClick={(e) => onSelect(l.id, e)}
            >
              <GripVertical className="h-3.5 w-3.5 flex-shrink-0 text-muted2" />
              <TypeIcon className={["h-3.5 w-3.5 flex-shrink-0", isSelected ? "text-[rgb(var(--accent-color))]" : "text-muted2"].join(" ")} />
              <span className={["flex-1 truncate text-[11px]", isSelected ? "text-text" : "text-muted"].join(" ")}>{layerLabel(l)}</span>
              <button
                type="button"
                draggable={false}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[rgb(var(--error-color)/0.15)] hover:text-[rgb(var(--error-color))]"
                title={t("text.deleteLayer")}
                onClick={(e) => { e.stopPropagation(); onDelete(l.id); }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {showLineBelow && <div className="pointer-events-none absolute left-2 right-2 bottom-0 h-0.5 bg-[rgb(var(--accent-color))]" />}
          </div>
        );
      })}
    </div>
  );
}

function IconBtn({ icon: Icon, onClick, title, disabled }) {
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
function FieldCell({ label, value, min, max, onChange }) {
  return (
    <div>
      <NumInput value={value} min={min} max={max} onChange={onChange} className="h-6 w-full" />
      <div className="mt-0.5 truncate text-center text-[9px] text-muted2">{label}</div>
    </div>
  );
}

// Segmented control — one bordered container, equal-width cells with inner
// dividers. Keeps rows of related toggles reading as a single unit instead of
// scattered pills.
function SegGroup({ options, className }) {
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

function ModeBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={[
        "flex-1 rounded-md border py-1.5 text-center text-[11px] transition-colors",
        active
          ? "border-[rgb(var(--accent-color)/0.3)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
          : "border-border/60 text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >{children}</button>
  );
}

function Switch({ on, onToggle }) {
  return (
    <button
      type="button"
      className={["relative h-[18px] w-8 rounded-full transition-colors", on ? "bg-[rgb(var(--accent-color))]" : "bg-border"].join(" ")}
      onClick={onToggle}
    >
      <span className={["absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform", on ? "translate-x-[14px]" : ""].join(" ")} />
    </button>
  );
}



function StackedField({ label, value, onChange, min, max }) {
  return (
    <div className="flex flex-1 min-w-0 flex-col items-center gap-1">
      <NumInput value={value} min={min} max={max} onChange={onChange} className="w-full h-6" />
      <span className="text-[10px] text-muted2">{label}</span>
    </div>
  );
}

// Stacked color field — small square swatch + label below. Width hugs the
// swatch so the rest of the row's stacked fields can share remaining space.
function StackedColorField({ label, color, onChange, opacity, onOpacityChange, presets }) {
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

function PairedFields({
  leftLabel, leftValue, onLeftChange,
  rightLabel, rightValue, onRightChange,
  min, max,
  linked, onToggleLink, linkTitle,
}) {
  return (
    <div className="flex flex-1 min-w-0 flex-col gap-1">
      <div className="flex items-stretch gap-2">
        <NumInput value={leftValue} min={min} max={max} onChange={onLeftChange} className="flex-1 min-w-0 h-6" />
        <NumInput value={rightValue} min={min} max={max} onChange={onRightChange} className="flex-1 min-w-0 h-6" />
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

function LinkBtn({ linked, onClick, title }) {
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

const WEIGHT_OPTIONS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "ExtraLight" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "SemiBold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "ExtraBold" },
  { value: 900, label: "Black" },
];

function WeightSelect({ value, onChange }) {
  const current = WEIGHT_OPTIONS.find((w) => w.value === value) || WEIGHT_OPTIONS[3];
  return (
    <select
      className="h-6 flex-1 rounded border border-border/60 bg-app px-2 text-[11px] text-text outline-none transition-colors hover:border-border focus:border-[rgb(var(--accent-color))]"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {WEIGHT_OPTIONS.map((w) => (
        <option key={w.value} value={w.value}>{w.label}</option>
      ))}
    </select>
  );
}

function FontSelect({ value, onChange }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState([]);
  const [filter, setFilter] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const listRef = useRef(null);
  const selectedRef = useRef(null);
  const inputRef = useRef(null);
  const openValueRef = useRef(value);

  const loadFonts = async () => {
    try {
      // Prefer Chromium's queryLocalFonts (works in packaged Electron)
      if (window.queryLocalFonts) {
        const fontData = await window.queryLocalFonts();
        const families = [...new Set(fontData.map((f) => f.family))].sort();
        setSystemFonts(families);
        return;
      }
    } catch {}
    // Fallback to IPC
    try {
      const fonts = await api.listSystemFonts();
      if (Array.isArray(fonts)) setSystemFonts(fonts);
    } catch {}
  };

  // Load on mount so arrow-cycling works before the dropdown is ever opened,
  // and re-query every time the dropdown opens so fonts installed while the
  // app is running show up without a restart.
  useEffect(() => { loadFonts(); }, []);
  useEffect(() => { if (open) loadFonts(); }, [open]);

  const allFonts = [
    ...FONT_OPTIONS.map((f) => f.family),
    ...systemFonts.filter((f) => !FONT_OPTIONS.some((o) => o.family === f)),
  ];

  const filtered = filter
    ? allFonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    : allFonts;

  // Scroll to selected font when dropdown opens — manipulate the list's
  // scrollTop directly so we don't bubble the scroll up to the inspector's
  // outer scroll container (which would shove the whole panel up).
  useEffect(() => {
    if (open && !filter && selectedRef.current && listRef.current) {
      const list = listRef.current;
      const item = selectedRef.current;
      list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
    }
    // Also focus the search input without scrolling parents.
    if (open && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    }
  }, [open]);

  // Reset highlight when filter changes
  useEffect(() => { setHighlightIdx(-1); }, [filter]);

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Arrow keys apply the highlighted font immediately so the canvas
      // previews it live while browsing the list.
      e.preventDefault();
      if (!filtered.length) return;
      const base = highlightIdx >= 0 ? highlightIdx : Math.max(filtered.indexOf(value), 0);
      const next = e.key === "ArrowDown"
        ? Math.min(base + 1, filtered.length - 1)
        : Math.max(base - 1, 0);
      setHighlightIdx(next);
      if (filtered[next] !== value) onChange(filtered[next]);
    } else if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < filtered.length) {
      e.preventDefault();
      onChange(filtered[highlightIdx]);
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    } else if (e.key === "Escape") {
      // Revert any live-previewed font back to what was set when the
      // dropdown opened.
      if (openValueRef.current && openValueRef.current !== value) onChange(openValueRef.current);
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    }
  };

  // Arrow keys on the CLOSED button cycle fonts directly — no need to open
  // the dropdown at all.
  const handleButtonKeyDown = (e) => {
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    if (!allFonts.length) return;
    const cur = allFonts.indexOf(value);
    const next = e.key === "ArrowDown"
      ? Math.min((cur < 0 ? -1 : cur) + 1, allFonts.length - 1)
      : Math.max((cur < 0 ? 1 : cur) - 1, 0);
    if (allFonts[next] !== value) onChange(allFonts[next]);
  };

  // Scroll highlighted item into view (only within the list — never bubble
  // the scroll up to the inspector's outer scroll container).
  useEffect(() => {
    if (highlightIdx < 0 || !listRef.current) return;
    const list = listRef.current;
    const el = list.children[highlightIdx];
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [highlightIdx]);

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-6 w-full items-center gap-2 rounded border border-border/60 bg-app px-2 transition-colors hover:border-border focus:border-[rgb(var(--accent-color))] outline-none"
        onClick={() => {
          if (!open) openValueRef.current = value;
          setOpen(!open);
        }}
        onKeyDown={handleButtonKeyDown}
      >
        <span className="flex-1 truncate text-left text-[11px] text-text" style={{ fontFamily: value }}>{value}</span>
        <span className="text-[11px] text-muted" style={{ fontFamily: value }}>Aa</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted2 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-chrome shadow-lg">
          <div className="border-b border-border/60 px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-muted2"
              placeholder={t("text.searchFonts")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div ref={listRef} className="max-h-72 overflow-y-auto">
            {filtered.map((family, idx) => (
              <button
                key={family}
                ref={family === value && !filter ? selectedRef : undefined}
                type="button"
                className={[
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors",
                  idx === highlightIdx ? "bg-hover" : "hover:bg-hover",
                  value === family ? "text-[rgb(var(--accent-color))]" : "text-text",
                ].join(" ")}
                style={{ fontFamily: `"${family}", sans-serif` }}
                onClick={() => { onChange(family); setOpen(false); setFilter(""); setHighlightIdx(-1); }}
              >
                <span className="flex-1">{family}</span>
                <span className="text-muted">Aa</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("text.noFonts")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Map flat layer fields ↔ unified "paint" object the picker expects.
function paintFromFields(layer, kind) {
  if (kind === "fill") {
    return {
      mode: layer.fillMode === "gradient" ? "gradient" : "solid",
      color: layer.fillColor,
      opacity: (layer.fillOpacity ?? 100) / 100,
      gradient: {
        from: layer.gradientFrom ?? "#ffffff",
        fromOpacity: (layer.gradientFromOpacity ?? 100) / 100,
        to: layer.gradientTo ?? "#d2a05a",
        toOpacity: (layer.gradientToOpacity ?? 100) / 100,
        angle: layer.gradientAngle ?? 90,
      },
    };
  }
  if (kind === "stroke") {
    return {
      mode: layer.strokeMode === "gradient" ? "gradient" : "solid",
      color: layer.strokeColor,
      opacity: 1,
      gradient: {
        from: layer.strokeGradFrom ?? layer.strokeColor ?? "#000000",
        fromOpacity: (layer.strokeGradFromOpacity ?? 100) / 100,
        to: layer.strokeGradTo ?? "#ffffff",
        toOpacity: (layer.strokeGradToOpacity ?? 100) / 100,
        angle: layer.strokeGradAngle ?? 90,
      },
    };
  }
  if (kind === "bg") {
    return {
      mode: layer.bgMode === "gradient" ? "gradient" : "solid",
      color: layer.bgColor,
      opacity: (layer.bgOpacity ?? 100) / 100,
      gradient: {
        from: layer.bgGradFrom ?? layer.bgColor ?? "#000000",
        fromOpacity: (layer.bgGradFromOpacity ?? 100) / 100,
        to: layer.bgGradTo ?? "#ffffff",
        toOpacity: (layer.bgGradToOpacity ?? 100) / 100,
        angle: layer.bgGradAngle ?? 90,
      },
    };
  }
  return null;
}

function paintToFields(patch, kind) {
  const out = {};
  const g = patch.gradient || {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  if (kind === "fill") {
    set("fillMode", patch.mode);
    set("fillColor", patch.color);
    if (patch.opacity !== undefined) out.fillOpacity = Math.round(patch.opacity * 100);
    set("gradientFrom", g.from);
    if (g.fromOpacity !== undefined) out.gradientFromOpacity = Math.round(g.fromOpacity * 100);
    set("gradientTo", g.to);
    if (g.toOpacity !== undefined) out.gradientToOpacity = Math.round(g.toOpacity * 100);
    set("gradientAngle", g.angle);
  } else if (kind === "stroke") {
    set("strokeMode", patch.mode);
    set("strokeColor", patch.color);
    set("strokeGradFrom", g.from);
    if (g.fromOpacity !== undefined) out.strokeGradFromOpacity = Math.round(g.fromOpacity * 100);
    set("strokeGradTo", g.to);
    if (g.toOpacity !== undefined) out.strokeGradToOpacity = Math.round(g.toOpacity * 100);
    set("strokeGradAngle", g.angle);
  } else if (kind === "bg") {
    set("bgMode", patch.mode);
    set("bgColor", patch.color);
    if (patch.opacity !== undefined) out.bgOpacity = Math.round(patch.opacity * 100);
    set("bgGradFrom", g.from);
    if (g.fromOpacity !== undefined) out.bgGradFromOpacity = Math.round(g.fromOpacity * 100);
    set("bgGradTo", g.to);
    if (g.toOpacity !== undefined) out.bgGradToOpacity = Math.round(g.toOpacity * 100);
    set("bgGradAngle", g.angle);
  }
  return out;
}

// Inline row: [swatch (opens picker)] + [Type dropdown] + [Opacity %] (+ optional trailing).
// All children are 24px tall. Swatch is a 36x24 rectangle so a gradient is legible
// without the endpoint colors looking like a "band" at the edge of a tiny square.
function PaintRow({ paint, availableModes, onUpdate, opacityValue, onOpacityChange, opacityMax = 100, trailing, multiStop = false }) {
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
      <select
        value={paint.mode}
        onChange={(e) => onUpdate({ mode: e.target.value })}
        className="h-6 flex-1 rounded border border-border/60 bg-app px-2 text-[11px] text-text outline-none cursor-pointer hover:border-border"
      >
        {availableModes.includes("solid") && <option value="solid">{t("text.solid")}</option>}
        {availableModes.includes("gradient") && <option value="gradient">{t("text.linear")}</option>}
      </select>
      {onOpacityChange && (
        <>
          <NumInput
            value={opacityValue ?? 100}
            min={0}
            max={opacityMax}
            onChange={onOpacityChange}
            className="w-10 h-6"
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

// Shared stroke/outline row — PaintRow with a trailing px NumInput. Used for
// both the text Stroke section and the sticker Outline section so visual
// changes only need to happen here.
function StrokeFieldRow({ paint, availableModes, onPaintUpdate, width, maxWidth, onWidthChange }) {
  return (
    <PaintRow
      paint={paint}
      availableModes={availableModes}
      onUpdate={onPaintUpdate}
      trailing={
        <>
          <NumInput
            value={width ?? 0}
            min={0}
            max={maxWidth}
            onChange={onWidthChange}
            className="w-10 h-6"
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
function ShadowFieldRow({ layer, onChange }) {
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

function ColorDot({ label, color, onChange, opacity, onOpacityChange, presets }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const hasAlpha = opacity != null && opacity < 1;
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-[10px] text-muted2">{label}</span>}
      <div
        ref={ref}
        className="h-5 w-5 cursor-pointer rounded border border-border/60"
        style={{ background: hasAlpha ? `linear-gradient(${hexToRgba(color, opacity)}, ${hexToRgba(color, opacity)}), repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 6px 6px` : color }}
        onClick={() => onChange && setOpen(!open)}
      />
      {open && onChange && (
        <ColorPickerPopover
          color={color}
          onChange={onChange}
          opacity={opacity}
          onOpacityChange={onOpacityChange}
          onClose={() => setOpen(false)}
          anchorEl={ref.current}
          presets={presets}
        />
      )}
    </div>
  );
}

function FooterBtn({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      className="flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40 disabled:pointer-events-none"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-3.5 w-3.5" />
      {label && <span>{label}</span>}
    </button>
  );
}

function PresetPreview({ preset }) {
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

function AlignBar({ layers, onLayersChange, allLayers }) {
  const { t } = useTranslation("editor");
  const ids = new Set(layers.map((l) => l.id));
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

/* ─── Sticker layer inspector ─────────────────────────────── */

const OVERLAY_EDGE_ICON = { bottom: PanelBottom, top: PanelTop, left: PanelLeft, right: PanelRight };

// One inspector for every overlay: the wash a frame preset ships with and the
// user's own 蒙层 are the same layer type, so both get paint (solid / multi-
// stop gradient) AND coverage (which edge it grows from + how far it reaches).
function OverlayLayerInspector({ layer, update }) {
  const { t } = useTranslation("editor");
  const s = normalizeScrim(layer);
  const updatePaint = (patch) => {
    const next = {};
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.opacity !== undefined) next.opacity = Math.round(patch.opacity * 100);
    if (patch.gradient) next.gradient = { ...s.gradient, ...patch.gradient };
    update(layer.id, next);
  };
  const edgeBtn = (active) => [
    "flex h-6 w-6 items-center justify-center rounded border transition-colors",
    active
      ? "border-[rgb(var(--accent-color)/0.4)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
      : "border-border/60 bg-app text-muted2 hover:bg-hover hover:text-text",
  ].join(" ");
  return (
    <>
      <Section label={t("text.overlaySettings")}>
        <PaintRow
          paint={{ mode: s.mode, color: s.color, opacity: s.opacity / 100, gradient: s.gradient }}
          availableModes={["solid", "gradient"]}
          multiStop
          onUpdate={updatePaint}
          opacityValue={s.opacity}
          onOpacityChange={(opacity) => update(layer.id, { opacity })}
        />
      </Section>
      <Section
        label={t("text.coverage")}
        right={(
          <div className="flex items-center gap-1" title={t("text.coverageEdge")}>
            {OVERLAY_EDGES.map((edge) => {
              const Icon = OVERLAY_EDGE_ICON[edge];
              return (
                <button
                  key={edge}
                  type="button"
                  title={t(`text.coverageEdges.${edge}`)}
                  aria-pressed={s.edge === edge}
                  className={edgeBtn(s.edge === edge)}
                  onClick={() => update(layer.id, { edge })}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
        )}
      >
        <SliderRow
          label={t("text.coverage")}
          min={5}
          max={100}
          value={Math.round(s.coverage * 100)}
          onChange={(coverage) => update(layer.id, { coverage: coverage / 100 })}
          suffix="%"
        />
      </Section>
    </>
  );
}

// Handwriting stickers keep the raw black-on-white generation around, so fill
// is re-editable after placement: merge the PaintRow patch into the stored
// fill, re-colorize the memoized alpha, and swap the sticker's data URL.
//
// Color-picker drags fire per pointer event, and each run ends in a full-res
// PNG encode (toDataURL) — so runs are serialized per layer with latest-wins
// coalescing: while one encode is in flight, further patches just replace the
// pending one. Encode rate becomes "as fast as encoding allows", not per event.
const pendingHandwritingFill = new Map(); // layerId → { layer, patch, update }

function mergeHandwritingPatch(base, patch) {
  const a = base || {};
  const merged = { ...a, ...patch };
  if (a.gradient || patch.gradient) merged.gradient = { ...a.gradient, ...patch.gradient };
  return merged;
}

async function applyHandwritingFill(layer, patch, update) {
  const id = layer.id;
  if (pendingHandwritingFill.has(id)) {
    const prev = pendingHandwritingFill.get(id);
    prev.layer = layer;
    prev.patch = mergeHandwritingPatch(prev.patch, patch);
    prev.update = update;
    return;
  }
  pendingHandwritingFill.set(id, { layer, patch, update });
  try {
    while (pendingHandwritingFill.has(id)) {
      const job = pendingHandwritingFill.get(id);
      pendingHandwritingFill.set(id, { ...job, patch: null });
      await runHandwritingFill(job.layer, job.patch, job.update);
      // Nothing new arrived during the run → done; otherwise loop with it.
      if (pendingHandwritingFill.get(id)?.patch == null) pendingHandwritingFill.delete(id);
    }
  } finally {
    pendingHandwritingFill.delete(id);
  }
}

async function runHandwritingFill(layer, patch, update) {
  const prev = layer.handwriting?.fill || { mode: "solid", color: "#ffffff" };
  const g = patch.gradient || {};
  const next = { ...prev };
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.opacity !== undefined) next.opacity = Math.round(patch.opacity * 100);
  for (const k of ["from", "fromOpacity", "to", "toOpacity", "angle"]) {
    if (g[k] !== undefined) next[k] = g[k];
  }
  if (next.mode === "gradient" && next.from === undefined) {
    Object.assign(next, { from: "#ffd76a", fromOpacity: 1, to: "#ff7a59", toOpacity: 1, angle: 90 });
  }
  const alpha = await handwritingAlphaFromUrl(mediaUrlFor(layer.handwriting.rawPath));
  if (!alpha) return;
  const canvas = colorizeHandwriting(alpha, next);
  update(layer.id, {
    stickerPath: canvas.toDataURL("image/png"),
    handwriting: { ...layer.handwriting, fill: next },
  });
}

function StickerLayerInspector({ layer, update, hasSceneDepth }) {
  const { t } = useTranslation("editor");
  const hasOutline = (layer.outlineWidth || 0) > 0;
  const hwFill = layer.handwriting?.fill;
  return (
    <>
      <Section label={t("text.transform")}>
        <SliderRow label={t("text.size")} min={2} max={200} value={Math.round((layer.scale ?? 0.4) * 100)} onChange={(v) => update(layer.id, { scale: v / 100 })} suffix="%" />
        <SliderRow label={t("text.opacity")} min={0} max={100} value={layer.opacity ?? 100} onChange={(v) => update(layer.id, { opacity: v })} suffix="%" />
      </Section>

      {/* Fill — handwriting stickers only: re-colorized from the cached raw
          generation, same controls as the text fill. */}
      {layer.handwriting?.rawPath && (
        <Section label={t("text.fill")}>
          <PaintRow
            paint={{
              mode: hwFill?.mode === "gradient" ? "gradient" : "solid",
              color: hwFill?.color ?? "#ffffff",
              opacity: (hwFill?.opacity ?? 100) / 100,
              gradient: {
                from: hwFill?.from ?? "#ffd76a",
                fromOpacity: hwFill?.fromOpacity ?? 1,
                to: hwFill?.to ?? "#ff7a59",
                toOpacity: hwFill?.toOpacity ?? 1,
                angle: hwFill?.angle ?? 90,
              },
            }}
            availableModes={["solid", "gradient"]}
            onUpdate={(patch) => { void applyHandwritingFill(layer, patch, update); }}
            opacityValue={layer.opacity ?? 100}
            onOpacityChange={(v) => update(layer.id, { opacity: v })}
          />
        </Section>
      )}

      {hasSceneDepth && (
        <Section label={t("text.depthPosition")}>
          <SliderRow min={0} max={100} value={Math.round((layer.zPosition ?? 1) * 100)} onChange={(v) => update(layer.id, { zPosition: v / 100 })} suffix="%" compact />
        </Section>
      )}

      {/* Outline — same shape as text Stroke (StrokeFieldRow handles both) */}
      <Section label={t("text.outline")} right={
        <Switch on={hasOutline} onToggle={() => update(layer.id, { outlineWidth: hasOutline ? 0 : 8 })} />
      }>
        {hasOutline && (
          <StrokeFieldRow
            paint={{
              mode: "solid",
              color: layer.outlineColor || "#ffffff",
              opacity: (layer.outlineOpacity ?? 100) / 100,
              gradient: { from: "#fff", fromOpacity: 1, to: "#000", toOpacity: 1, angle: 90 },
            }}
            availableModes={["solid"]}
            onPaintUpdate={(patch) => {
              const next = {};
              if (patch.color !== undefined) next.outlineColor = patch.color;
              if (patch.opacity !== undefined) next.outlineOpacity = Math.round(patch.opacity * 100);
              if (Object.keys(next).length) update(layer.id, next);
            }}
            width={layer.outlineWidth}
            maxWidth={200}
            onWidthChange={(v) => update(layer.id, { outlineWidth: v })}
          />
        )}
      </Section>

      <Section label={t("text.shadow")} right={
        <Switch on={layer.shadow} onToggle={() => update(layer.id, { shadow: !layer.shadow })} />
      }>
        {layer.shadow && (
          <ShadowFieldRow layer={layer} onChange={(patch) => update(layer.id, patch)} />
        )}
      </Section>

      <GlowSection layer={layer} update={update} />
    </>
  );
}

/* Outer glow — shared by the text and sticker inspectors: stacked zero-offset
   colored blur; blur size rides the stroke-row width input, intensity = number
   of stacked passes. */
function GlowSection({ layer, update }) {
  const { t } = useTranslation("editor");
  return (
    <Section label={t("text.glow")} right={
      <Switch on={layer.glow} onToggle={() => update(layer.id, { glow: !layer.glow })} />
    }>
      {layer.glow && (
        <>
          <StrokeFieldRow
            paint={{
              mode: "solid",
              color: layer.glowColor || "#ffd76a",
              opacity: (layer.glowOpacity ?? 80) / 100,
              gradient: { from: "#fff", fromOpacity: 1, to: "#000", toOpacity: 1, angle: 90 },
            }}
            availableModes={["solid"]}
            onPaintUpdate={(patch) => {
              const next = {};
              if (patch.color !== undefined) next.glowColor = patch.color;
              if (patch.opacity !== undefined) next.glowOpacity = Math.round(patch.opacity * 100);
              if (Object.keys(next).length) update(layer.id, next);
            }}
            width={layer.glowBlur ?? 24}
            maxWidth={120}
            onWidthChange={(v) => update(layer.id, { glowBlur: v })}
          />
          <SliderRow
            label={t("text.glowIntensity")}
            min={1}
            max={4}
            value={layer.glowIntensity ?? 2}
            onChange={(v) => update(layer.id, { glowIntensity: v })}
          />
        </>
      )}
    </Section>
  );
}

/* ─── Sticker library picker modal ────────────────────────── */

function StickerPickerModal({ onPick, onClose }) {
  const { t } = useTranslation("editor");
  const [stickers, setStickers] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.stickerList();
        if (!cancelled) setStickers(list || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = !query.trim()
    ? stickers
    : stickers.filter((s) => {
        const q = query.trim().toLowerCase();
        return (s.name || "").toLowerCase().includes(q) ||
               (s.sourceLabel || "").toLowerCase().includes(q);
      });

  // Rendered absolutely inside the TextPanel — so it overlays *just* the panel,
  // doesn't block the canvas/toolbar, and stays open while the user adds
  // multiple stickers in a row (click sticker → layer added → picker stays).
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-chrome">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("text.pickSticker")}</div>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={onClose}
            title={t("text.done")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("text.search")}
          autoFocus
          className="mt-3 h-7 w-full rounded-md border border-border/60 bg-app px-2 text-[11px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-3 py-3">
        {loading ? (
          <div className="grid place-items-center py-12 text-[11px] text-muted">{t("text.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center py-12 text-center text-[10px] leading-relaxed text-muted2">
            {query ? t("text.noMatches") : t("text.noStickers")}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                className="group flex flex-col text-left"
                title={s.name || s.sourceLabel || s.filename}
              >
                <div className="aspect-square overflow-hidden rounded-md border border-border bg-checker transition-colors group-hover:border-[rgb(var(--accent-color))]">
                  <img
                    src={mediaUrlFor(s.thumbPath || s.path)}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="mt-1 truncate px-0.5 text-[9px] text-muted2">{s.name || s.sourceLabel || "—"}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
