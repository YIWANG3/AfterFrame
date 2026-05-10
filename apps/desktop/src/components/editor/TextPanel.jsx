import { useState, useCallback, useEffect, useRef } from "react";
import ColorPickerPopover from "../collage/ColorPickerPopover";

function hexToRgba(hex, alpha = 1) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function mediaUrlFor(filePath) {
  if (!filePath) return "";
  if (filePath.startsWith("media://")) return filePath;
  const encoded = filePath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `media://${encoded}`;
}
import {
  Plus, Trash2, Type,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Columns2, Rows2, ChevronDown, Check, Undo2, Redo2, RotateCcw, Link, Unlink, Layers, Sparkles, GripVertical, FolderOpen, RotateCw, Cannabis, Image as ImageIcon, X,
} from "lucide-react";
import { isTextLayer, isStickerLayer, layerLabel } from "./layerStack";
import {
  FONT_OPTIONS, COLOR_SWATCHES, PRESETS,
  createDefaultLayer, createStickerLayer, applyPreset, cloneLayers, getBgPadding,
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
}) {
  const selected = layers.filter((l) => selectedIds.has(l.id));
  const selectedText = selected.filter(isTextLayer);
  const current = selected.length === 1 ? selected[0] : null;
  const currentIsText = isTextLayer(current);
  const currentIsSticker = isStickerLayer(current);
  // Inspector always shows text controls when applicable. If no text is selected
  // and no sticker is selected, fall back to the topmost text layer so the panel
  // layout never collapses (avoids jumpy UX).
  const editTarget = currentIsText
    ? current
    : (currentIsSticker ? null : (layers.filter(isTextLayer).slice(-1)[0] || null));

  const update = useCallback((id, patch) => {
    onLayersChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, [layers, onLayersChange]);

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
        {/* Presets */}
        <Section label="Presets">
          <div className="grid grid-cols-4 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className={[
                  "flex flex-col items-center gap-1 rounded-md border px-1 py-2 transition-colors",
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
            ))}
          </div>
        </Section>

        {/* Scene depth — image-level metadata. One ML inference per image; results
            cached and shared by every text layer's z position slider. */}
        <Section label="Scene Depth" action={
          hasSceneDepth ? (
            <button
              type="button"
              onClick={onClearDepth}
              className="text-[10px] text-muted2 hover:text-text"
            >
              Clear
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
              <><Layers className="h-3.5 w-3.5 animate-pulse" /> Inferring depth…</>
            ) : hasSceneDepth ? (
              <><Layers className="h-3.5 w-3.5" /> Depth ready — regenerate</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5" /> Generate scene depth</>
            )}
          </button>
          {hasSceneDepth && (
            <>
              <SliderRow
                label="Soft"
                min={0}
                max={30}
                value={Math.round(depthFeather * 100)}
                onChange={(v) => onDepthFeatherChange?.(v / 100)}
                suffix="%"
              />
              {editTarget && (
                <SliderRow
                  label="Position"
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
                Show depth map
              </label>
            </>
          )}
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted2">
              <span className="uppercase tracking-wide">Model</span>
              {depthModel?.isCustom && (
                <button
                  type="button"
                  onClick={() => onResetDepthModel?.()}
                  className="text-[10px] text-muted2 hover:text-text"
                  title="Use bundled model"
                >
                  Reset
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onPickDepthModel?.()}
              className="flex h-7 w-full items-center gap-2 rounded-md border border-border/60 bg-app px-2 text-[11px] text-text transition-colors hover:border-border hover:bg-hover"
              title={depthModel?.path || "Select a CoreML depth model"}
            >
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted2" />
              <span className="truncate flex-1 text-left">
                {depthModel?.name || "Default"}
              </span>
              <span className="text-[9px] text-muted2 flex-shrink-0">
                {depthModel?.isCustom ? "Custom" : "Bundled"}
              </span>
            </button>
          </div>
        </Section>

        {/* Layers — text + sticker */}
        <Section label="Layers" action={
          <div className="flex items-center gap-0.5">
            <IconBtn
              icon={Cannabis}
              title={stickerPickerOpen ? "Hide sticker picker" : "Add sticker layer"}
              onClick={() => setStickerPickerOpen((v) => !v)}
            />
            <IconBtn icon={Type} title="Add text layer" onClick={addLayer} />
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

        {editTarget && (() => {
          // Alias so the rest of the inspector keeps reading `current` —
          // when no text layer is selected, this transparently edits the
          // topmost text layer instead of collapsing the panel.
          const current = editTarget;
          return (
          <>
            {/* Content */}
            <Section label="Content">
              <textarea
                className="w-full resize-y rounded-md border border-border/60 bg-app px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none transition-colors placeholder:text-muted2 focus:border-[rgb(var(--accent-color))]"
                rows={2}
                value={current.text}
                onChange={(e) => update(current.id, { text: e.target.value })}
                placeholder="Enter text…"
              />
            </Section>


            {/* Font */}
            <Section label="Font">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <FontSelect value={current.fontFamily} onChange={(f) => update(current.id, { fontFamily: f })} />
                </div>
                <NumInput value={current.fontSize} min={8} max={2000} onChange={(v) => update(current.id, { fontSize: v })} className="w-12 h-6" />
              </div>
            </Section>

            {/* Style */}
            <Section label="Style">
              <div className="flex items-center gap-1.5">
                <WeightSelect value={current.fontWeight ?? (current.bold ? 700 : 400)} onChange={(w) => update(current.id, { fontWeight: w, bold: w >= 600 })} />
                <ToggleBtn active={current.italic} onClick={() => update(current.id, { italic: !current.italic })}><span className="text-[11px] italic">I</span></ToggleBtn>
                <ToggleBtn active={current.underline} onClick={() => update(current.id, { underline: !current.underline })}><span className="text-[11px] underline">U</span></ToggleBtn>
              </div>
            </Section>

            {/* Fill */}
            <Section label="Fill">
              <PaintRow
                paint={paintFromFields(current, "fill")}
                availableModes={["solid", "gradient"]}
                onUpdate={(patch) => update(current.id, paintToFields(patch, "fill"))}
                opacityValue={current.opacity}
                onOpacityChange={(v) => update(current.id, { opacity: v })}
              />
            </Section>

            {/* Stroke */}
            <Section label="Stroke" right={<Switch on={current.strokeEnabled} onToggle={() => update(current.id, { strokeEnabled: !current.strokeEnabled })} />}>
              {current.strokeEnabled && (
                <>
                  <PaintRow
                    paint={paintFromFields(current, "stroke")}
                    availableModes={["solid", "gradient"]}
                    onUpdate={(patch) => update(current.id, paintToFields(patch, "stroke"))}
                  />
                  <SliderRow label="Width" min={0} max={20} value={current.strokeWidth ?? 0} onChange={(v) => update(current.id, { strokeWidth: v })} />
                </>
              )}
            </Section>

            {/* Background */}
            <Section label="Background" right={<Switch on={current.bgMode !== "none"} onToggle={() => update(current.id, { bgMode: current.bgMode !== "none" ? "none" : "solid" })} />}>
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
                        <div className="mb-1 text-[10px] text-muted2">Padding</div>
                        <div className="flex items-stretch gap-3">
                          <PairedFields
                            leftLabel="T" leftValue={pad.top} onLeftChange={setTop}
                            rightLabel="B" rightValue={pad.bottom} onRightChange={setBottom}
                            min={-50} max={80}
                            linked={vPadLinked} onToggleLink={toggleV}
                            linkTitle={vPadLinked ? "Unlink top/bottom" : "Link top/bottom"}
                          />
                          <PairedFields
                            leftLabel="L" leftValue={pad.left} onLeftChange={setLeft}
                            rightLabel="R" rightValue={pad.right} onRightChange={setRight}
                            min={-50} max={80}
                            linked={hPadLinked} onToggleLink={toggleH}
                            linkTitle={hPadLinked ? "Unlink left/right" : "Link left/right"}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </Section>

            {/* Shadow */}
            <Section label="Shadow" right={<Switch on={current.shadow} onToggle={() => update(current.id, { shadow: !current.shadow })} />}>
              {current.shadow && (
                <>
                  <div className="mt-2 flex items-stretch gap-2">
                    <StackedColorField
                      label="Color"
                      color={current.shadowColor}
                      onChange={(c) => update(current.id, { shadowColor: c })}
                      opacity={(current.shadowOpacity ?? 60) / 100}
                      onOpacityChange={(v) => update(current.id, { shadowOpacity: Math.round(v * 100) })}
                      presets={COLOR_SWATCHES}
                    />
                    <StackedField label="X" value={current.shadowX} min={-50} max={50} onChange={(v) => update(current.id, { shadowX: v })} />
                    <StackedField label="Y" value={current.shadowY} min={-50} max={50} onChange={(v) => update(current.id, { shadowY: v })} />
                    <StackedField label="Blur" value={current.shadowBlur} min={0} max={100} onChange={(v) => update(current.id, { shadowBlur: v })} />
                  </div>
                </>
              )}
            </Section>
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
      </div>

      {/* Footer */}
      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <FooterBtn icon={RotateCcw} label="Reset" onClick={onReset} />
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
        const TypeIcon = isStickerLayer(l) ? Cannabis : Type;
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
                title="Delete layer"
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

function ToggleBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={[
        "flex h-6 min-w-[32px] items-center justify-center rounded-md border px-2 text-[11px] font-semibold transition-colors",
        active
          ? "border-[rgb(var(--accent-color)/0.3)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
          : "border-border/60 text-muted hover:border-border hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >{children}</button>
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

function SliderRow({ label, min, max, value, onChange, suffix, compact }) {
  return (
    <div className={["flex items-center gap-2", compact ? "" : "mt-2"].join(" ")}>
      {label && <label className="min-w-[48px] text-[10px] text-muted2">{label}</label>}
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider flex-1"
      />
      <NumInput value={value} min={min} max={max} onChange={onChange} />
      {suffix && <span className="text-[10px] text-muted2">{suffix}</span>}
    </div>
  );
}

function NumInput({ value, min, max, onChange, className = "w-11" }) {
  const ref = useRef(null);
  const DRAG_THRESHOLD = 3;

  const handleMouseDown = (e) => {
    // If already focused (editing), let native input handle it
    if (document.activeElement === ref.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = value;
    let dragging = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragging = true;
      const next = Math.min(max, Math.max(min, startVal + Math.round(dx)));
      onChange(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!dragging) {
        // Was a click, not a drag — focus the input for typing
        ref.current?.focus();
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <input
      ref={ref}
      type="number" min={min} max={max} value={value}
      onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
      onFocus={(e) => e.target.select()}
      onMouseDown={handleMouseDown}
      style={{ cursor: "ew-resize" }}
      className={`hide-spinner rounded-md border border-border/60 bg-app px-1.5 py-0.5 text-center text-[11px] text-text outline-none focus:border-[rgb(var(--accent-color))] focus:cursor-text ${className}`}
    />
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
        title="Edit color"
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
  const [open, setOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState([]);
  const [filter, setFilter] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const loadedRef = useRef(false);
  const listRef = useRef(null);
  const selectedRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
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
        const fonts = await window.mediaWorkspace?.listSystemFonts?.();
        if (Array.isArray(fonts)) setSystemFonts(fonts);
      } catch {}
    })();
  }, []);

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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((prev) => {
        const next = Math.min(prev + 1, filtered.length - 1);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < filtered.length) {
      e.preventDefault();
      onChange(filtered[highlightIdx]);
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    } else if (e.key === "Escape") {
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    }
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
        className="flex h-6 w-full items-center gap-2 rounded border border-border/60 bg-app px-2 transition-colors hover:border-border"
        onClick={() => setOpen(!open)}
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
              placeholder="Search fonts…"
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
              <div className="px-2.5 py-2 text-[11px] text-muted2">No fonts found</div>
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
function PaintRow({ paint, availableModes, onUpdate, opacityValue, onOpacityChange, opacityMax = 100, trailing }) {
  const [open, setOpen] = useState(false);
  const swatchRef = useRef(null);
  const isGrad = paint.mode === "gradient";
  const checker = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 5px 5px";
  const swatchBg = isGrad
    ? `linear-gradient(90deg, ${hexToRgba(paint.gradient.from, paint.gradient.fromOpacity)}, ${hexToRgba(paint.gradient.to, paint.gradient.toOpacity)}), ${checker}`
    : `linear-gradient(${hexToRgba(paint.color, paint.opacity)}, ${hexToRgba(paint.color, paint.opacity)}), ${checker}`;
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="h-6 w-6 flex-shrink-0 cursor-pointer rounded p-px outline-none bg-transparent"
        title={isGrad ? "Edit gradient" : "Edit color"}
      >
        <span className="block h-full w-full rounded-[3px]" style={{ background: swatchBg }} />
      </button>
      <select
        value={paint.mode}
        onChange={(e) => onUpdate({ mode: e.target.value })}
        className="h-6 flex-1 rounded border border-border/60 bg-app px-2 text-[11px] text-text outline-none cursor-pointer hover:border-border"
      >
        {availableModes.includes("solid") && <option value="solid">Solid</option>}
        {availableModes.includes("gradient") && <option value="gradient">Linear</option>}
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
        />
      )}
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
  const style = {
    fontSize: "16px",
    fontWeight: s.bold ? 700 : 400,
    fontFamily: s.fontFamily || "Plus Jakarta Sans",
    color: s.fillColor === "transparent" ? "transparent" : (s.fillColor || "#fff"),
    WebkitTextStroke: s.strokeEnabled ? `${s.strokeWidth || 1}px ${s.strokeColor || "#fff"}` : undefined,
    textShadow: s.shadow ? `${s.shadowX || 0}px ${s.shadowY || 0}px ${s.shadowBlur || 0}px ${s.shadowColor || "#000"}` : undefined,
    opacity: s.opacity != null ? s.opacity / 100 : 1,
  };
  const bg = s.bgMode === "solid" ? { background: s.bgColor || "#000", padding: "2px 6px", borderRadius: "3px" } : {};
  return <div className="flex h-7 items-center justify-center" style={{ ...style, ...bg }}>Aa</div>;
}

function AlignBar({ layers, onLayersChange, allLayers }) {
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
      <button type="button" className={abtn} title="Align left" onClick={() => apply(alignLeft)}><AlignHorizontalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Center H" onClick={() => apply(alignCenterH)}><AlignHorizontalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Align right" onClick={() => apply(alignRight)}><AlignHorizontalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title="Align top" onClick={() => apply(alignTop)}><AlignVerticalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Center V" onClick={() => apply(alignCenterV)}><AlignVerticalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Align bottom" onClick={() => apply(alignBottom)}><AlignVerticalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title="Distribute H" onClick={() => apply(distributeH)}><Columns2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Distribute V" onClick={() => apply(distributeV)}><Rows2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/* ─── Sticker layer inspector ─────────────────────────────── */

function StickerLayerInspector({ layer, update, hasSceneDepth }) {
  const hasOutline = (layer.outlineWidth || 0) > 0;
  return (
    <>
      <Section label="Transform">
        <SliderRow label="Size" min={2} max={200} value={Math.round((layer.scale ?? 0.4) * 100)} onChange={(v) => update(layer.id, { scale: v / 100 })} suffix="%" />
        <SliderRow label="Opacity" min={0} max={100} value={layer.opacity ?? 100} onChange={(v) => update(layer.id, { opacity: v })} suffix="%" />
      </Section>

      {hasSceneDepth && (
        <Section label="Depth Position">
          <SliderRow min={0} max={100} value={Math.round((layer.zPosition ?? 1) * 100)} onChange={(v) => update(layer.id, { zPosition: v / 100 })} suffix="%" compact />
        </Section>
      )}

      {/* Outline — shape mirrors the text Stroke section: PaintRow + Width slider */}
      <Section label="Outline" right={
        <Switch on={hasOutline} onToggle={() => update(layer.id, { outlineWidth: hasOutline ? 0 : 8 })} />
      }>
        {hasOutline && (
          <>
            <PaintRow
              paint={{
                mode: "solid",
                color: layer.outlineColor || "#ffffff",
                opacity: 1,
                gradient: { from: "#fff", fromOpacity: 1, to: "#000", toOpacity: 1, angle: 90 },
              }}
              availableModes={["solid"]}
              onUpdate={(patch) => {
                if (patch.color !== undefined) update(layer.id, { outlineColor: patch.color });
              }}
            />
            <SliderRow label="Width" min={1} max={64} value={layer.outlineWidth} onChange={(v) => update(layer.id, { outlineWidth: v })} />
          </>
        )}
      </Section>

      {/* Shadow — identical structure to text Shadow section */}
      <Section label="Shadow" right={
        <Switch on={layer.shadow} onToggle={() => update(layer.id, { shadow: !layer.shadow })} />
      }>
        {layer.shadow && (
          <div className="mt-2 flex items-stretch gap-2">
            <StackedColorField
              label="Color"
              color={layer.shadowColor}
              onChange={(c) => update(layer.id, { shadowColor: c })}
              opacity={(layer.shadowOpacity ?? 60) / 100}
              onOpacityChange={(v) => update(layer.id, { shadowOpacity: Math.round(v * 100) })}
              presets={COLOR_SWATCHES}
            />
            <StackedField label="X" value={layer.shadowX} min={-50} max={50} onChange={(v) => update(layer.id, { shadowX: v })} />
            <StackedField label="Y" value={layer.shadowY} min={-50} max={50} onChange={(v) => update(layer.id, { shadowY: v })} />
            <StackedField label="Blur" value={layer.shadowBlur} min={0} max={100} onChange={(v) => update(layer.id, { shadowBlur: v })} />
          </div>
        )}
      </Section>
    </>
  );
}

/* ─── Sticker library picker modal ────────────────────────── */

function StickerPickerModal({ onPick, onClose }) {
  const [stickers, setStickers] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.mediaWorkspace?.stickerList?.();
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
    <div className="absolute inset-0 z-30 flex flex-col bg-chrome/97 backdrop-blur-sm">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">Pick a sticker</div>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={onClose}
            title="Done"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          autoFocus
          className="mt-3 h-7 w-full rounded-md border border-border/60 bg-app px-2 text-[11px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-3 py-3">
        {loading ? (
          <div className="grid place-items-center py-12 text-[11px] text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center py-12 text-center text-[10px] leading-relaxed text-muted2">
            {query ? "No matches" : "No stickers in library — switch to the Sticker tool to make one."}
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
                    src={mediaUrlFor(s.path)}
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

