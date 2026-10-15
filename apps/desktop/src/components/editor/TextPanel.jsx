import api from "../../api";
import { useState, useCallback, useEffect, useEffectEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  Type, ChevronDown, Undo2, Redo2, RotateCcw, Layers, Sparkles, FolderOpen, Cannabis, Brush, Blend,
} from "lucide-react";
import HandwritingModal from "./handwriting/HandwritingModal";
import { SliderRow, Toggle } from "../../ui";
import BorderControls from "./components/BorderControls";
import FooterButton from "./components/FooterButton";
import MyLogosRow from "./components/MyLogosRow";
import CameraLogosBlock from "./components/CameraLogosBlock";
import { isTextLayer, isStickerLayer, isOverlayLayer, isFrameLayer } from "./layerStack";
import {
  FONT_OPTIONS, PRESETS,
  createDefaultLayer, createStickerLayer, createOverlayLayer, applyPreset, getBgPadding, pickTextStyle,
} from "./textState";
import { fontFamilyAvailable, loadSystemFontFamilies } from "./fontFamilies";
import { readPref, writePref } from "../../utils/prefs";
import { LOCKED_HINT_KEY } from "../DesktopOnly";

import { Section, IconBtn, FieldCell, SegGroup, PairedFields, PresetPreview, AlignBar } from "./text/controls";
import FontSelect, { WeightSelect } from "./text/FontSelect";
import { PaintRow, StrokeFieldRow, ShadowFieldRow } from "./text/PaintRow";
import LayerList from "./text/LayerList";
import OverlayLayerInspector from "./text/OverlayLayerInspector";
import StickerLayerInspector from "./text/StickerLayerInspector";
import GlowSection from "./text/GlowSection";
import StickerPickerModal from "./text/StickerPickerModal";
import { mergeOwnLayers, paintFromFields, paintToFields } from "./text/textPanelLogic";

// What "Photo info" offers, as the token sources frame templates use.
const TOKEN_SOURCES = {
  camera_model: { content: "{camera_model}" },
  lens_model: { content: "{lens_model}" },
  exif: { exif: { fields: ["focal", "aperture", "shutter", "iso"], labeled: false } },
  date: { content: "{date}" },
  author: { content: "{author}" },
};

const TEXT_STYLE_PREF = "text.style";

// The look for a new text layer; a font no longer installed (another Mac, the
// web build) falls back to the default one, the rest of the look stays.
function rememberedTextStyle() {
  const style = readPref(TEXT_STYLE_PREF, {}, pickTextStyle);
  if (style.fontFamily && !fontFamilyAvailable(style.fontFamily)) delete style.fontFamily;
  return style;
}

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
  onSaveTemplate,
  onRenameTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  // "text": what is written on the photo. "frame": the frame (templates,
  // canvas, photo info, my logos, frame text); the layer inspectors below are
  // shared.
  mode = "text",
  // Frame mode: add to the frame; the editor picks the spot and the colour.
  onAddFrameInfo,
  onAddFrameText,
  onPlaceLogo,
  // This photo's camera logo (useFrameTool.cameraLogo): place it, or give
  // the brand one of my logos (null: its own back). Shown first among the logos.
  cameraLogo,
  onPlaceCameraLogo,
  onChooseCameraLogo,
  canvasPad,
  onCanvasPad,
  onCanvasPadCommit,
  canvasBg,
  onCanvasBg,
}) {
  const { t } = useTranslation("editor");
  const frameMode = mode === "frame";
  // Each tool lists its own layers: the frame's, or the photo's.
  const ownLayers = layers.filter((l) => isFrameLayer(l) === frameMode);
  const otherCount = layers.length - ownLayers.length;
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
    : ((currentIsSticker || currentIsOverlay) ? null : (ownLayers.filter(isTextLayer).slice(-1)[0] || null));

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
  // Re-derive the link toggles only when the selection moves to another
  // layer; editing the current layer's padding must not flip them back.
  const syncPadLinks = useEffectEvent(() => {
    if (!current) return;
    const pad = getBgPadding(current);
    setVPadLinked(pad.top === pad.bottom);
    setHPadLinked(pad.left === pad.right);
  });
  const currentId = current?.id;
  useEffect(() => { syncPadLinks(); }, [currentId]);

  // "+ Text" starts from the look of the text the user last styled — in this
  // panel, on the canvas or with a preset, on this photo or an earlier one —
  // rather than the built-in default (utils/prefs.js). Selecting a layer
  // alone changes nothing, and frame text, with a look of its own, is left
  // out. Undo/redo of a style counts: what is on screen is what was chosen.
  const styleSource = !frameMode && currentIsText && !isFrameLayer(current) ? current : null;
  const styleSourceId = styleSource?.id ?? null;
  const styleJson = styleSource ? JSON.stringify(pickTextStyle(styleSource)) : null;
  const lastStyleRef = useRef(null);
  useEffect(() => {
    const prev = lastStyleRef.current;
    lastStyleRef.current = styleSourceId ? { id: styleSourceId, json: styleJson } : null;
    if (styleSourceId && prev?.id === styleSourceId && prev.json !== styleJson) {
      writePref(TEXT_STYLE_PREF, JSON.parse(styleJson));
    }
  }, [styleSourceId, styleJson]);
  // A remembered system font may have been uninstalled since: list what is
  // installed now, so "+ Text" can tell.
  useEffect(() => {
    const family = readPref(TEXT_STYLE_PREF, {}, pickTextStyle).fontFamily;
    if (family && !FONT_OPTIONS.some((f) => f.family === family)) void loadSystemFontFamilies();
  }, []);

  const addLayer = () => {
    const nl = createDefaultLayer(rememberedTextStyle());
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
  };

  // Photo info in the frame: a text layer that knows it is the camera model
  // (or the lens, the EXIF row, the date, the author), so a saved template
  // shows the right one on the next photo. Nothing to show → nothing added.
  const [tokenMissing, setTokenMissing] = useState(null);
  const addFrameInfo = async (key) => {
    const added = await onAddFrameInfo?.(key, TOKEN_SOURCES[key]);
    setTokenMissing(added ? null : key);
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
        {!frameMode && <Section label={t("text.presets")} action={
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
        </Section>}

        {/* The Frame tool: templates, the canvas around the photo, and what
            goes into the frame, in the order a frame is made. */}
        {frameMode && onCanvasPad && (
          <>
            <Section label={t("frame.templates")}>
              <BorderControls
                part="templates"
                templates={framePresets}
                thumbs={frameThumbs}
                cellAspect={frameCellAspect}
                onApplyPreset={onApplyPreset}
                onClearPreset={onClearPreset}
                onSaveTemplate={onSaveTemplate}
                onRenameTemplate={onRenameTemplate}
                onDuplicateTemplate={onDuplicateTemplate}
                onDeleteTemplate={onDeleteTemplate}
              />
            </Section>
            <Section label={t("frame.canvas")}>
              <BorderControls part="canvas" pad={canvasPad} onPad={onCanvasPad} onPadCommit={onCanvasPadCommit} bg={canvasBg} onBg={onCanvasBg} />
            </Section>
            <Section label={t("frame.add")}>
              <div className="mb-1.5 text-[10px] text-muted2">{t("frame.info")}</div>
              <div className="flex flex-wrap gap-1" data-token-menu="true">
                {Object.keys(TOKEN_SOURCES).map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-token={key}
                    onClick={() => addFrameInfo(key)}
                    className="rounded-md border border-border/60 bg-app px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-border hover:text-text"
                  >
                    {t(`text.tokens.${key}`)}
                  </button>
                ))}
                <button
                  type="button"
                  data-frame-text="true"
                  onClick={() => onAddFrameText?.()}
                  className="flex items-center gap-1 rounded-md border border-dashed border-border/70 px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-border hover:text-text"
                >
                  <Type className="h-3 w-3" />
                  {t("frame.freeText")}
                </button>
              </div>
              {tokenMissing && (
                <div className="mt-1 text-[10.5px] text-muted2">
                  {t(tokenMissing === "author" ? "text.tokens.noAuthor" : "text.tokens.missing")}
                </div>
              )}
              {cameraLogo && onChooseCameraLogo && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] text-muted2">{t("frame.cameraLogos")}</div>
                  <CameraLogosBlock cameraLogo={cameraLogo} onPlace={onPlaceCameraLogo} onChoose={onChooseCameraLogo} />
                </div>
              )}
              {onPlaceLogo && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] text-muted2">{t("frame.customLogos")}</div>
                  <MyLogosRow onPlace={onPlaceLogo} />
                </div>
              )}
            </Section>
            <Section label={t("frame.layers")}>
              {ownLayers.length === 0 && <div className="text-[10.5px] leading-snug text-muted2">{t("frame.layersEmpty")}</div>}
              <LayerList
                layers={ownLayers}
                selectedIds={selectedIds}
                onSelect={selectLayer}
                onLayersChange={(next) => onLayersChange(mergeOwnLayers(layers, next, frameMode))}
                onDelete={(id) => (onDeleteLayer || deleteLayer)(id)}
              />
            </Section>
          </>
        )}

        {/* Scene depth — image-level metadata. One ML inference per image; results
            cached and shared by every text layer's z position slider. Without a
            depth engine (the web build; Windows for now, api.can("depth")) the
            section says where it is available instead. */}
        {!frameMode && !(api.has("computeDepth") && api.can("depth")) && (
          <Section label={t("text.depth.title")}>
            <div className="w-full rounded-md border border-border/40 bg-app px-3 py-2 text-left text-[11px] leading-snug text-muted2">
              {t(LOCKED_HINT_KEY, { ns: "common" })}
            </div>
          </Section>
        )}
        {!frameMode && api.has("computeDepth") && api.can("depth") && <Section label={t("text.depth.title")} action={
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
        </Section>}

        {/* Layers written on the photo — overlay + text + sticker. The frame's
            own layers are listed (and added) in the Frame tool. */}
        {!frameMode && <Section label={t("text.layers")} action={
          <div className="flex items-center gap-0.5">
            <IconBtn
              icon={Blend}
              title={t("text.addOverlayLayer")}
              onClick={addOverlayLayer}
            />
            <IconBtn
              icon={Brush}
              title={api.has("startTextImage") ? t("text.addHandwriting") : `${t("text.addHandwriting")} · ${t(LOCKED_HINT_KEY, { ns: "common" })}`}
              disabled={!api.has("startTextImage")}
              onClick={() => setHandwritingOpen(true)}
            />
            <IconBtn
              icon={Cannabis}
              title={api.can("stickerExtract")
                ? (stickerPickerOpen ? t("text.hideStickerPicker") : t("text.addStickerLayer"))
                : `${t("text.addStickerLayer")} · ${t(LOCKED_HINT_KEY, { ns: "common" })}`}
              disabled={!api.can("stickerExtract")}
              onClick={() => setStickerPickerOpen((v) => !v)}
            />
            <IconBtn icon={Type} title={t("text.addTextLayer")} onClick={addLayer} />
          </div>
        }>
          <LayerList
            layers={ownLayers}
            selectedIds={selectedIds}
            onSelect={selectLayer}
            onLayersChange={(next) => onLayersChange(mergeOwnLayers(layers, next, frameMode))}
            onDelete={(id) => (onDeleteLayer || deleteLayer)(id)}
          />
          {otherCount > 0 && <div className="mt-1.5 text-[10.5px] text-muted2" data-frame-layers-hint="true">{t("frame.inFrameTool", { count: otherCount })}</div>}
          {selectedText.length >= 2 && <AlignBar layers={selectedText} onLayersChange={onLayersChange} allLayers={layers} />}
        </Section>}

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
            <Section label={t("text.stroke")} right={<Toggle on={current.strokeEnabled} onChange={() => update(current.id, { strokeEnabled: !current.strokeEnabled })} />}>
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
            <Section label={t("text.background")} right={<Toggle on={current.bgMode !== "none"} onChange={() => update(current.id, { bgMode: current.bgMode !== "none" ? "none" : "solid" })} />}>
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
            <Section label={t("text.shadow")} right={<Toggle on={current.shadow} onChange={() => update(current.id, { shadow: !current.shadow })} />}>
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
        <FooterButton icon={RotateCcw} label={t("text.reset")} onClick={onReset} />
        <FooterButton icon={Undo2} onClick={onUndo} disabled={!canUndo} />
        <FooterButton icon={Redo2} onClick={onRedo} disabled={!canRedo} />
        <button
          type="button"
          className="ml-auto flex h-[30px] items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color))] px-4 text-[11px] font-semibold text-accentInk transition-all hover:brightness-110"
          onClick={onApply}
        >
          {t("overlay.apply")}
        </button>
      </div>
    </>
  );
}
