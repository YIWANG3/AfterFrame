import api from "../api";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileName } from "../utils/format";
import { needsOnDemandHd, useOnDemandHdPreview } from "../hooks/useOnDemandHdPreviews";
import useRawEditSource, { useNeutralRawRender } from "../hooks/useRawEditSource";
import { MIN_FREE_ANGLE, MAX_FREE_ANGLE } from "./editor/cropMath";
import AiRepaintPanel from "./editor/AiRepaintPanel";
import BeforeAfterCompare from "./editor/BeforeAfterCompare";
import TextPanel from "./editor/TextPanel";
import TextCanvas from "./editor/TextCanvas";
import StickerPanel from "./editor/StickerPanel";
import { useFrameTool } from "./editor/state/useFrameTool";
import {
  getSourceDimensions,
  releaseCanvasImage,
  buildPreviewSource,
  buildDepthMaskCanvas,
  buildTransformedCanvas, cutRotatedCrop,
  bgToCss,
} from "./editor/render/canvasHelpers";
import { drawLayersOnCanvas } from "./editor/render/drawLayers";
import { createDefaultLayer, createOverlayLayer, createStickerLayer, measureTextWidthDOM } from "./editor/textState";
import { FRAME_FONTS } from "./editor/frameTemplates";
import { isFrameLayer } from "./editor/layerStack";
import { outputGeometry } from "./editor/frameUserTemplates";
import { backgroundLightness, layerBoxes, placeLogo, placeText, swapLogo } from "./editor/logoPlacement";
import { invalidatePersonalLogos, isPersonalLogoRef, preparePersonalLogo } from "./editor/render/personalLogos";
import StickerRegionOverlay from "./editor/components/StickerRegionOverlay";
import EditorHeader from "./editor/components/EditorHeader";
import EditorLoading from "./editor/components/EditorLoading";
import ToolRail from "./editor/components/ToolRail";
import PanelChrome from "./editor/components/PanelChrome";
import CropPanel from "./editor/components/CropPanel";
import CropOverlay from "./editor/components/CropOverlay";
import SplitPanel from "./editor/components/SplitPanel";
import SplitOverlay from "./editor/components/SplitOverlay";
import LutPanel from "./editor/LutPanel";
import { useLutTool } from "./editor/state/useLutTool";
import { fullSizeParallelism, gradeCanvas, lutPoolInfo } from "./editor/lut/lutPool";
import { BASE_STATE, cloneState, stateEquals } from "./editor/state/editorStateModel";
import { useEditorHistory } from "./editor/state/useEditorHistory";
import { useEditorImage } from "./editor/state/useEditorImage";
import { useEditorViewport } from "./editor/state/useEditorViewport";
import { useEditorSave } from "./editor/state/useEditorSave";
import { useCropTool } from "./editor/state/useCropTool";
import { initialSplitState, useSplitTool } from "./editor/state/useSplitTool";
import { useSplitExport, resolveSplitOutputDir } from "./editor/state/useSplitExport";
import { useTextTool } from "./editor/state/useTextTool";
import { useStickerTool } from "./editor/state/useStickerTool";
import { useDepthModel } from "./editor/state/useDepthModel";
import { useSceneDepth } from "./editor/state/useSceneDepth";
import { useAddToFolder } from "../hooks/useAddToFolder";
import { bool, clearPref, readPref, text, writePref } from "../utils/prefs";
import { matchShortcut } from "../shortcuts/store";
import {
  PANEL_WIDTH,
  PANEL_GAP,
  CANVAS_SIDE_PADDING,
  getStageBounds,
  getBasePlacement,
  getMinZoomForCrop,
  getImageRect,
  getNormalizedCrop,
  getOutputView,
  clampImagePlacement,
  hasPad,
  layersToDisplay,
  layersFromDisplay,
  bakeLayersIntoCrop,
  IDENTITY_VIEW_TRANSFORM,
  fitViewTransformToStage,
  transformOutputView,
} from "./editor/imageMath";
import {
  isTextLayer,
  isStickerLayer,
  isOverlayLayer,
} from "./editor/layerStack";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function padEquals(a, b) {
  const pa = { top: 0, right: 0, bottom: 0, left: 0, ...(a || {}) };
  const pb = { top: 0, right: 0, bottom: 0, left: 0, ...(b || {}) };
  return pa.top === pb.top && pa.right === pb.right && pa.bottom === pb.bottom && pa.left === pb.left;
}

const SPLIT_DIR_PREF = "split.outputDir";
const SPLIT_SUBFOLDER_PREF = "split.subfolder";

// The folder split panels last went to, if it is still there (an unplugged
// drive, a deleted folder: back to the original's folder).
async function rememberedSplitDir() {
  const dir = readPref(SPLIT_DIR_PREF, null, text(4096));
  if (!dir || !api.has?.("statDirs")) return null;
  const found = await api.statDirs([dir]).catch(() => []);
  return found?.includes(dir) ? dir : null;
}

function createInitialSnapshot(viewportSize, transformedPreview) {
  const placement = getBasePlacement(viewportSize, transformedPreview);
  const baseState = {
    ...BASE_STATE,
    split: initialSplitState(),
    imageZoom: 1,
  };
  const imageRect = getImageRect(baseState, transformedPreview, placement);
  return {
    ...baseState,
    cropRect: {
      ...imageRect,
      x: placement.centerX - imageRect.width / 2,
      y: placement.centerY - imageRect.height / 2,
    },
  };
}


// Editor shortcuts must not steal keys from text inputs / the layer editor.
function shouldIgnoreKey(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

const RULER_W = 600;
const TICK_RANGE = 45;
const PX_PER_DEG = RULER_W / (TICK_RANGE * 2);

function AngleRuler({ value, viewportWidth, viewportHeight, centerX, onChangeStart, onChange, onChangeEnd }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;

    function angleFromX(clientX) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      return clamp(Math.round(((clientX - cx) / PX_PER_DEG) * 10) / 10, MIN_FREE_ANGLE, MAX_FREE_ANGLE);
    }

    function onPointerDown(e) {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      el.setPointerCapture(e.pointerId);
      onChangeStart?.();
      onChange(angleFromX(e.clientX));
    }

    function onPointerMove(e) {
      if (!draggingRef.current) return;
      onChange(angleFromX(e.clientX));
    }

    function onPointerUp(e) {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      onChangeEnd?.();
    }

    function onDblClick(e) {
      e.preventDefault();
      e.stopPropagation();
      onChangeStart?.();
      onChange(0);
      onChangeEnd?.();
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("dblclick", onDblClick);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("dblclick", onDblClick);
    };
  }, [onChangeStart, onChange, onChangeEnd]);

  const vw = viewportWidth || 0;
  const top = viewportHeight - 88;
  const left = centerX !== undefined ? centerX - RULER_W / 2 : (vw - RULER_W) / 2;

  const ticks = [];
  for (let deg = -TICK_RANGE; deg <= TICK_RANGE; deg++) {
    const isMajor = deg % 10 === 0;
    const isMid = deg % 5 === 0 && !isMajor;
    const h = isMajor ? 16 : isMid ? 11 : 6;
    const opacity = isMajor ? 0.6 : isMid ? 0.4 : 0.2;
    ticks.push(
      <div
        key={deg}
        style={{
          position: "absolute",
          left: `${RULER_W / 2 + deg * PX_PER_DEG}px`,
          top: 0,
          width: "1px",
          height: `${h}px`,
          background: "rgb(var(--text-color))",
          opacity,
          transform: "translateX(-0.5px)",
        }}
      />,
    );
    if (isMajor) {
      ticks.push(
        <div
          key={`l${deg}`}
          style={{
            position: "absolute",
            left: `${RULER_W / 2 + deg * PX_PER_DEG}px`,
            top: `${h + 6}px`,
            transform: "translateX(-50%)",
            fontSize: "10px",
            color: "rgb(var(--text-color))",
            opacity: deg === 0 ? 0.6 : 0.3,
            whiteSpace: "nowrap",
          }}
        >
          {deg}°
        </div>,
      );
    }
  }

  const indicatorX = RULER_W / 2 + value * PX_PER_DEG;

  return (
    <div
      className="pointer-events-auto absolute select-none"
      style={{ left: `${left}px`, top: `${top}px`, width: `${RULER_W}px`, zIndex: 60 }}
    >
      <div
        ref={trackRef}
        data-testid="angle-ruler"
        style={{
          position: "relative",
          width: `${RULER_W}px`,
          height: "32px",
          cursor: "ew-resize",
          touchAction: "none",
        }}
      >
        {ticks}
        <div
          style={{
            position: "absolute",
            left: `${indicatorX}px`,
            top: 0,
            width: "2px",
            height: "14px",
            background: "rgb(var(--accent-color))",
            borderRadius: "1px",
            transform: "translateX(-1px)",
            opacity: 0.9,
          }}
        />
      </div>
      <div className="mt-0.5 text-center text-[11px] font-medium tabular-nums text-muted">
        {value.toFixed(1)}°
      </div>
    </div>
  );
}

// How light the photo is under a spot (output px): the corner a logo is put in
// when there is no bar. 0 is black, 1 white.
function photoLightness(source, geom, spot) {
  const sample = document.createElement("canvas");
  sample.width = 8;
  sample.height = 8;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(
    source,
    spot.cx - spot.width / 2 - geom.left + geom.cropX, spot.cy - spot.height / 2 - geom.top + geom.cropY, spot.width, spot.height,
    0, 0, 8, 8,
  );
  const { data } = ctx.getImageData(0, 0, 8, 8);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  return sum / (data.length / 4);
}

const isLogoFileDrag = (event) => [...(event.dataTransfer?.items || [])]
  .some((entry) => entry.kind === "file" && (entry.type === "image/svg+xml" || entry.type === "image/png"));

export default function EditorOverlay({
  open, item, catalogKey = null, collections, sourceCollectionId, onAddToCollection, onClose, onSaveComplete, pushToast,
}) {
  const { t } = useTranslation("editor");
  // Opened from a folder, what the editor makes (a saved copy, split panels,
  // a repaint) can join it. Saves and split panels are web downloads, not
  // catalog assets, so on the web only the repaint box shows.
  const folderJoin = useAddToFolder({ open, collections, sourceCollectionId, onAddToCollection });
  const fileSaveFolder = api.can("fileSystem") ? folderJoin.folder : null;
  const imageCanvasRef = useRef(null);
  const depthOverlayCanvasRef = useRef(null);
  const nativeSaveSourcePathRef = useRef(null);
  const quickSavePathRef = useRef(null);
  const carryLutRef = useRef(null);
  // Unified undo/redo: ONE timeline over both the transform state AND the layer
  // stack, so Cmd+Z and every panel Undo button reverse the same last action.
  const {
    editorState, editorStateRef,
    layers, layersRef,
    history, historyIndex, historyRef, historyIndexRef, baseSnapshotRef,
    syncHistory, rebaseHistory, apply: applyState, applyLayers, record: recordState, commitCurrent,
    commitLayers, commitLayersCoalesced, flushLayerCommit,
    undo: rawHandleUndo, redo: rawHandleRedo,
  } = useEditorHistory();
  const [spacePressed, setSpacePressed] = useState(false);
  const [viewTransform, setViewTransform] = useState(IDENTITY_VIEW_TRANSFORM);
  const viewTransformRef = useRef(IDENTITY_VIEW_TRANSFORM);
  viewTransformRef.current = viewTransform;
  const [tool, setTool] = useState("crop");
  // The two tools that edit layers on the composed canvas: Text (what is
  // written on the photo) and Frame (the frame around it).
  const layerTool = tool === "text" || tool === "frame";
  const [message, setMessage] = useState("");
  // Split export destination: target folder (null = the original's folder)
  // and whether to create a <stem>_split subfolder inside it. Not part of the
  // undo history — a destination, not an edit. Both are remembered for the
  // next photo (utils/prefs.js); a remembered folder that is gone is dropped.
  const [splitOutputDir, setSplitOutputDir] = useState(null);
  const [splitSubfolder, setSplitSubfolder] = useState(true);
  const [compareState, setCompareState] = useState(null); // { afterPath, layout: "side"|"stack" }
  // Text tool — selection + clipboard + layer CRUD (commits into the shared
  // history via commitLayers).
  const {
    selectedIds, setSelectedIds,
    moveLayer: handleMoveLayer, deleteLayer: handleDeleteLayer,
    addTextLayer, selectLayers, copySelection, pasteClipboard, deleteSelection,
  } = useTextTool({ layers, layersRef, commit: commitLayers });
  // Scene-level depth: one Depth Anything V2 inference per source image,
  // cached as both an Image (for visualization) and a Canvas (for pixel reads).
  // RAW originals (.cr3/.3fr/…) can't be decoded by the renderer or sharp, so
  // edit from the HD preview: the camera's embedded JPEG, made when first
  // needed (one the lightbox already made is reused). Where that JPEG is
  // smaller than the RAW (a Fuji GFX embeds 4000×3000 of 11648×8735), a
  // full-size render replaces it, so a save keeps the RAW's pixels
  // (useRawEditSource). Wait for both rather than start on the thumbnail, so
  // edits aren't laid out on a 512px image; fall back to the HD, then the
  // thumbnail, if they fail.
  // The save target still derives from the original path (saveBasePath) →
  // edits land next to the source file as <stem>_edited.jpg, not in the
  // catalog previews dir.
  const isRaw = item?.asset_type === "raw";
  const onDemandHd = useOnDemandHdPreview({ current: item, enabled: open, catalogKey });
  const awaitingHd = open && needsOnDemandHd(item) && onDemandHd === undefined;
  const rawHdPath = isRaw ? (item?.preview_hd_path || item?.image_preview_hd_path || onDemandHd || null) : null;
  const rawEditSource = useRawEditSource({
    item, hdPath: rawHdPath, enabled: open && !awaitingHd,
    onPreviewOnly: (notice) => pushToast?.({
      title: t("overlay.rawPreviewOnlyTitle"),
      message: t(notice.key, notice.values),
      ttl: 9000,
    }),
  });
  const awaitingRawSource = open && isRaw && rawEditSource === undefined;
  const awaitingSource = awaitingHd || awaitingRawSource;
  // The LUT tool grades a RAW on Apple's rendering of it, never the camera's
  // embedded JPEG (docs/lut-plan.md, RAW): once the tool is opened on a RAW,
  // the picture swaps to that render for the rest of the session — edits,
  // layers and history stay. Not after an Apply: the baked picture would be
  // lost, so the LUT grades what Apply made.
  const lutAvailable = api.can("lut") && api.has("listLuts");
  const itemKey = item?.asset_id ?? item?.image_path ?? null;
  // Per photo (keyed, so the first render of the next photo is already clean).
  const [neutralItem, setNeutralItem] = useState(null);
  const [bakedItem, setBakedItem] = useState(null);
  const neutralWanted = open && neutralItem === itemKey;
  const sourceBaked = open && bakedItem === itemKey;
  const neutralRaw = useNeutralRawRender({ item, enabled: open && isRaw && lutAvailable && neutralWanted });
  const neutralPath = isRaw ? neutralRaw?.path || null : null;
  // Apple's render asked for and not back yet (a couple of seconds): the
  // picture on screen is still the camera's JPEG, about to be replaced.
  const neutralRendering = isRaw && lutAvailable && !sourceBaked && neutralWanted && neutralRaw === undefined;
  const neutralSwapRef = useRef(null);
  neutralSwapRef.current = neutralPath;
  const resolvedSourcePath = awaitingSource ? null : (isRaw
    ? (neutralPath || rawEditSource || rawHdPath || item?.image_preview_path || item?.preview_path)
    : item?.image_path) || item?.image_preview_path || item?.raw_preview_path || null;
  // After an Apply the working picture is the baked canvas: the path it came
  // from must not change under it (a render landing late would reload it).
  const frozenSourceRef = useRef({ key: null, path: null });
  const sourcePath = sourceBaked && frozenSourceRef.current.key === itemKey
    ? frozenSourceRef.current.path
    : resolvedSourcePath;
  frozenSourceRef.current = { key: itemKey, path: sourcePath };
  useEffect(() => {
    if (!open) {
      setNeutralItem(null);
      setBakedItem(null);
    } else if (tool === "lut" && isRaw && lutAvailable && !sourceBaked) {
      setNeutralItem(itemKey);
    }
  }, [open, tool, isRaw, lutAvailable, sourceBaked, itemKey]);
  const saveBasePath = item?.image_path || sourcePath;
  // Image load lives in its own hook. `setSourceImage`/`setPreviewSource` + the
  // ref are exposed so Apply/Text-apply can promote a freshly baked canvas.
  const {
    sourceImage, previewSource, loadState, loadError, sourceImageRef,
    setSourceImage, setPreviewSource,
  } = useEditorImage({
    open,
    sourcePath,
    waiting: awaitingSource,
    decodeErrorLabel: t("overlay.decodeError"),
    missingSourceLabel: t("overlay.noSource"),
  });
  const depth = useSceneDepth({ sourcePath });
  const {
    generating: depthGenerating,
    error: depthError,
    setError: setDepthError,
    sourcePathOnDisk: depthSourcePath,
    fieldImageRef: depthFieldImageRef,
    fieldCanvasRef: depthFieldCanvasRef,
    version: depthFieldVersion,
    feather: depthFeather,
    setFeather: setDepthFeather,
    mapVisible: depthMapVisible,
    setMapVisible: setDepthMapVisible,
  } = depth;
  const clearSceneDepth = depth.clear;
  const loadDepthFromPath = depth.loadFromPath;
  const handleComputeDepth = depth.compute;
  const handleClearDepth = depth.clearAll;

  const { imageCache: stickerImageCache, region: sticker } = useStickerTool({
    layers,
    assetId: item?.asset_id,
  });

  const { depthModel, pickDepthModel: handlePickDepthModel, resetDepthModel: handleResetDepthModel } =
    useDepthModel({
      sourcePath,
      onComputeDepth: (opts) => handleComputeDepth(opts),
      onError: setDepthError,
    });

  // A RAW is edited from a picture made of it (its HD preview, a render in a
  // cache); the title names the RAW, not that file.
  const sourceLabel = (isRaw ? fileName(item?.image_path) : null) || fileName(sourcePath) || item?.stem || "Selected asset";
  const {
    aspectKey,
    freeAngle,
    quarterTurns,
    flipX,
    flipY,
    cropRect,
    imageZoom,
  } = editorState;
  const discreteRotationDeg = quarterTurns * 90;
  const rotationDeg = discreteRotationDeg + freeAngle;
  const showCropUi = tool === "crop";
  // Full-resolution photo size in the split region's basis (after quarter turns).
  const splitSourceDims = useMemo(() => {
    if (!sourceImage) return null;
    const { width, height } = getSourceDimensions(sourceImage);
    return quarterTurns % 2 ? { width: height, height: width } : { width, height };
  }, [sourceImage, quarterTurns]);

  // Soft reset (panel "Reset"): clear layers as an undoable step.
  function layerReset() {
    commitLayers([]);
    setSelectedIds(new Set());
    clearSceneDepth();
  }
  // Hard reset (new image / after Apply): clear layers live; the history itself
  // is wiped by the surrounding syncHistory([], -1) + re-seeded by the initial
  // snapshot effect.
  function layerResetHard() {
    applyLayers([]);
    setSelectedIds(new Set());
    clearSceneDepth();
  }


  // Thin wrapper around the pure layer renderer that supplies the sticker
  // image cache from our closure.
  function drawTextLayersOnCanvas(ctx, canvasWidth, canvasHeight, layersToRender) {
    drawLayersOnCanvas(ctx, canvasWidth, canvasHeight, layersToRender, stickerImageCache);
  }

  function currentLayerHead() {
    return layersRef.current || [];
  }

  function getFitTransformForState(state) {
    if (!transformedPreview || !viewportSize || !placement) return IDENTITY_VIEW_TRANSFORM;
    // pad=0: the output IS the photo and the crop-space placement already centers
    // it, so the screen view transform is neutral. (Anchoring to imageRect here
    // would fold imageZoom into the fit and shrink the photo — see review F6.)
    if (!hasPad(state.canvas?.pad)) return IDENTITY_VIEW_TRANSFORM;
    const nextImageRect = getImageRect(state, transformedPreview, placement);
    const nextCrop = getNormalizedCrop(state, nextImageRect);
    const nextOutputView = getOutputView(state, transformedPreview, nextCrop, nextImageRect);
    return fitViewTransformToStage(nextOutputView?.rect, viewportSize, placement);
  }

  function resetViewToFit(state = editorStateRef.current) {
    setViewTransform(getFitTransformForState(state));
  }

  function applyCanvasPad(nextPad, { record = false } = {}) {
    const s = editorStateRef.current;
    const oldPad = s.canvas?.pad || BASE_STATE.canvas.pad;
    if (padEquals(oldPad, nextPad)) return;
    const nextState = { ...s, canvas: { ...s.canvas, pad: nextPad } };
    // Layers are stored in full-photo coords, so a margin change doesn't move
    // them — the display derivation reflows automatically. Just fit + record.
    resetViewToFit(nextState);
    if (record) recordState(nextState);
    else applyState(nextState);
  }

  function handleUndo() {
    flushWheelCommit?.(); // land a pending wheel edit as its own step first (F8)
    const oldPad = editorStateRef.current.canvas?.pad || BASE_STATE.canvas.pad;
    rawHandleUndo();
    // viewTransform isn't in the transform history; refit when the undo crossed a
    // border change so the framed view stays centered (review F5).
    if (!padEquals(oldPad, editorStateRef.current.canvas?.pad || BASE_STATE.canvas.pad)) resetViewToFit();
  }

  function handleRedo() {
    flushWheelCommit?.(); // F8
    const oldPad = editorStateRef.current.canvas?.pad || BASE_STATE.canvas.pad;
    rawHandleRedo();
    if (!padEquals(oldPad, editorStateRef.current.canvas?.pad || BASE_STATE.canvas.pad)) resetViewToFit();
  }

  // How much of the framed output must remain inside the stage when panning the
  // view — keeps a border drag from flinging the canvas off-screen (review F5).
  const PAN_MIN_VISIBLE = 80;
  function beginOutputViewPan(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startPoint = pointFromClient(event.clientX, event.clientY);
    const startTransform = viewTransformRef.current || IDENTITY_VIEW_TRANSFORM;
    const rect = outputRect; // untransformed output rect (viewTransform applied on top)
    target?.setPointerCapture?.(event.pointerId);

    const clampPan = (x, y) => {
      if (!rect || !viewportSize?.width) return { x, y };
      const w = rect.width * startTransform.scale;
      const h = rect.height * startTransform.scale;
      const left = rect.x * startTransform.scale;
      const top = rect.y * startTransform.scale;
      return {
        x: clamp(x, PAN_MIN_VISIBLE - left - w, viewportSize.width - PAN_MIN_VISIBLE - left),
        y: clamp(y, PAN_MIN_VISIBLE - top - h, viewportSize.height - PAN_MIN_VISIBLE - top),
      };
    };

    const onMove = (moveEvent) => {
      const point = pointFromClient(moveEvent.clientX, moveEvent.clientY);
      const dx = point.x - startPoint.x;
      const dy = point.y - startPoint.y;
      const next = clampPan(startTransform.x + dx, startTransform.y + dy);
      setViewTransform({ ...startTransform, x: next.x, y: next.y });
    };

    const onUp = (upEvent) => {
      if (target?.hasPointerCapture?.(upEvent.pointerId)) target.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }


  function handleTextApply() {
    flushLayerCommit();
    const renderable = layers.filter((l) => isTextLayer(l) || isStickerLayer(l) || isOverlayLayer(l));
    if (!sourceImage || renderable.length === 0) return;
    const { width: sw, height: sh } = getSourceDimensions(sourceImage);
    const composite = document.createElement("canvas");
    composite.width = sw;
    composite.height = sh;
    const ctx = composite.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceImage, 0, 0, sw, sh);

    // Composite layers with depth-mask awareness — must match the export path
    // in saveImage.js, otherwise Apply bakes text in front of foreground objects
    // even when zPosition < 1 places it behind them.
    const depthCanvas = depthFieldCanvasRef.current;
    // Overlays resolve against the visible content rect (the crop), not the
    // full photo — same mapping as the export path in saveImage.js, otherwise
    // Apply-then-export and direct export bake different gradient slices.
    const forBake = (layer) =>
      layer.type === "overlay" && normalizedCrop ? { ...layer, overlayRect: normalizedCrop } : layer;
    for (const layer of renderable) {
      const useDepth = depthCanvas && layer.zPosition != null && layer.zPosition < 1;
      if (!useDepth) {
        drawTextLayersOnCanvas(ctx, sw, sh, [forBake(layer)]);
        continue;
      }
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      drawTextLayersOnCanvas(tmp.getContext("2d"), sw, sh, [forBake(layer)]);
      const mask = buildDepthMaskCanvas(depthCanvas, sw, sh, layer.zPosition, depthFeather);
      const tctx = tmp.getContext("2d");
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(mask, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      releaseCanvasImage(mask);
      releaseCanvasImage(tmp);
    }

    composite.naturalWidth = sw;
    composite.naturalHeight = sh;
    const nextPreview = buildPreviewSource(composite);
    const previousSource = sourceImageRef.current;
    sourceImageRef.current = composite;
    setSourceImage(composite);
    setPreviewSource(nextPreview);
    nativeSaveSourcePathRef.current = null;
    // The LUT is not baked: it carries over onto the new picture.
    carryLutRef.current = editorStateRef.current.lut;
    setBakedItem(itemKey);
    releaseCanvasImage(previousSource);
    baseSnapshotRef.current = null;
    quickSavePathRef.current = null;
    syncHistory([], -1);
    applyState(BASE_STATE);
    setViewTransform(IDENTITY_VIEW_TRANSFORM);
    layerResetHard();
    setMessage("Text applied");
  }

  // Reset editor state for a new source image (the image load itself lives in
  // useEditorImage). Also kicks off a cached-depth lookup for this source.
  const resetItemRef = useRef(null);
  useEffect(() => {
    if (!open) resetItemRef.current = null; // a reopened editor starts fresh
    if (!open || !sourcePath) return undefined;
    // The LUT tool swapping a RAW's picture for Apple's rendering of the same
    // RAW: keep the tool, the edits and the history.
    if (resetItemRef.current === itemKey && neutralSwapRef.current === sourcePath) {
      nativeSaveSourcePathRef.current = sourcePath;
      return undefined;
    }
    resetItemRef.current = itemKey;
    let active = true;
    setTool("crop");
    setMessage("");
    setCompareState(null);
    setSplitOutputDir(null);
    setSplitSubfolder(readPref(SPLIT_SUBFOLDER_PREF, true, bool));
    void rememberedSplitDir().then((dir) => { if (active && dir) setSplitOutputDir(dir); });
    setDepthError(null);
    baseSnapshotRef.current = null;
    quickSavePathRef.current = null;
    nativeSaveSourcePathRef.current = sourcePath;
    flushLayerCommit(); // drop any pending layer scrub before wiping history
    syncHistory([], -1);
    applyState(BASE_STATE);
    setViewTransform(IDENTITY_VIEW_TRANSFORM); // review F7: don't carry a stale fit across photos
    layerResetHard();

    // Auto-load cached depth if it exists for this source image. Same image
    // (path + size + mtime) hits the cache; no ML inference.
    if (api.has("computeDepth") && api.can("depth")) {
      api.computeDepth({ sourcePath, checkOnly: true })
        .then((cached) => {
          if (active && cached?.outputPath) {
            loadDepthFromPath(cached.outputPath).catch(() => {});
          }
        })
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [open, sourcePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Photo + rotation/flip — bridges the loaded image and the transform state;
  // feeds the viewport geometry, save, and the frame tool.
  const transformedPreview = useMemo(() => {
    if (!previewSource) return null;
    return buildTransformedCanvas(previewSource, previewSource.width, previewSource.height, discreteRotationDeg, flipX, flipY);
  }, [previewSource, discreteRotationDeg, flipX, flipY]);

  // Viewport geometry (ref, measured size, placement, image rect, normalized
  // crop, composed output view, coord mapping).
  const { viewportRef, viewportSize, placement, imageRect, normalizedCrop, outputView, outputRect, pointFromClient } =
    useEditorViewport({ open, transformedPreview, editorState });

  // Once the preview + viewport are ready, seed the initial centered-crop
  // snapshot (also the "Reset" target). Stays here — it records into history.
  useEffect(() => {
    if (!transformedPreview || !placement || baseSnapshotRef.current) return;
    // Do not put the zero-size placeholder stage into undo/Reset history.
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const initial = createInitialSnapshot(viewportSize, transformedPreview);
    baseSnapshotRef.current = cloneState(initial);
    recordState(initial);
    // An Apply re-seeds the history; the LUT chosen before it comes back as
    // the first step after the base, so it can still be undone.
    if (carryLutRef.current) {
      recordState({ ...cloneState(initial), lut: carryLutRef.current });
      carryLutRef.current = null;
    }
  }, [placement, transformedPreview, viewportSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // Layers are STORED in full-photo coords; the panels edit in the current
  // display basis. Derive display layers on render, and fold edits back to
  // storage in the change callbacks — a pure, drift-free boundary that replaces
  // the old imperative basis remapping.
  const displayLayers = useMemo(
    () => layersToDisplay(layers, transformedPreview, normalizedCrop, editorState.canvas?.pad),
    [layers, transformedPreview, normalizedCrop, editorState.canvas],
  );
  const toStorage = (dl) => layersFromDisplay(dl, transformedPreview, normalizedCrop, editorState.canvas?.pad);
  const applyLayersDisplay = (dl) => applyLayers(toStorage(dl));
  const commitLayersDisplay = (dl) => commitLayers(toStorage(dl));
  const commitLayersCoalescedDisplay = (dl, sig) => commitLayersCoalesced(toStorage(dl), sig);

  const cropCenter = cropRect
    ? {
        x: cropRect.x + cropRect.width / 2,
        y: cropRect.y + cropRect.height / 2,
      }
    : null;

  // Crop / transform tool — pointer interactions + commit ops. Owns
  // activeInteraction (cursor) and the in-flight pointer/angle drag state.
  // Text mode keeps the normal wheel zoom/pan active even with a border, so the
  // composed view can still be inspected comfortably.
  const {
    activeInteraction,
    commitAspect, commitTransform,
    beginCropResize, beginImagePan,
    handlePointerMove, handlePointerEnd,
    beginAngleDrag, updateAngle, endAngleDrag,
    flushWheelCommit,
  } = useCropTool({
    open: open && tool !== "split", previewSource, transformedPreview, viewportSize, placement, imageRect,
    viewportRef, editorState, editorStateRef, pointFromClient,
    apply: applyState, record: recordState, commitCurrent, rebaseHistory,
  });

  // Seamless split tool — region interactions + aspect/count commits, recorded
  // into the same history via editorState.split (docs/split-carousel-plan.md).
  const splitTool = useSplitTool({
    active: tool === "split", transformedPreview, placement, sourceDims: splitSourceDims,
    editorState, editorStateRef, pointFromClient,
    apply: applyState, record: recordState, commitCurrent,
  });
  const splitToolRef = useRef(splitTool);
  splitToolRef.current = splitTool;
  const splitCenter = splitTool.rectPx
    ? { x: splitTool.rectPx.x + splitTool.rectPx.width / 2, y: splitTool.rectPx.y + splitTool.rectPx.height / 2 }
    : null;
  // The viewport routes pointer events to whichever tool owns the drag.
  const viewportPointerMove = tool === "split" ? splitTool.handlePointerMove : handlePointerMove;
  const viewportPointerEnd = tool === "split" ? splitTool.handlePointerEnd : handlePointerEnd;

  // The text tool with an active border renders the COMPOSED view (cropped
  // content + margins) via a clipping window; every other view is the plain
  // crop-space photo. The canvas element remounts when the mode flips, so the
  // draw effect keys on it too.
  const padActive = hasPad(editorState.canvas?.pad);
  const screenOutputView = layerTool ? transformOutputView(outputView, viewTransform) : outputView;
  const screenOutputRect = screenOutputView?.rect ?? null;
  const screenImageRect = tool === "split"
    ? (splitTool.splitImageRect || imageRect)
    : layerTool ? (screenOutputView?.photoRect || imageRect) : imageRect;
  const composedView = layerTool && padActive && screenOutputView ? screenOutputView : null;
  // The two draw effects below key on presence, not identity: imageRect is a
  // fresh object every render and composedView flips with the tool.
  const composedActive = !!composedView;
  const hasImageRect = !!imageRect;

  // LUT tool (docs/lut-plan.md): the preview graded at full strength, turned
  // like the photo, drawn over it at the chosen strength — the same mix the
  // save computes, so the slider costs a redraw, not a regrade.
  const lutState = editorState.lut;
  const lutTool = useLutTool({
    open, active: tool === "lut", previewSource, transformedPreview, editorStateRef, lut: lutState,
    // No thumbnails of the camera's JPEG only to throw them away.
    baseReady: !neutralRendering,
    apply: applyState, record: recordState, pushToast, t,
  });
  const lutGradedTransformed = useMemo(() => {
    const graded = lutTool.gradedPreview;
    if (!graded) return null;
    return buildTransformedCanvas(graded, graded.width, graded.height, discreteRotationDeg, flipX, flipY);
  }, [lutTool.gradedPreview, discreteRotationDeg, flipX, flipY]);
  const lutStrength = lutState?.strength ?? 1;
  const lutShown = !!(lutState && lutGradedTransformed && !lutTool.comparing && lutStrength > 0);
  const lutBase = !isRaw || !lutAvailable ? null
    : sourceBaked ? "baked"
    : neutralRaw?.path ? (neutralRaw.renderer === "libraw" ? "libraw" : "apple")
    : neutralRendering ? "rendering"
    : "embedded";

  useEffect(() => {
    const canvas = imageCanvasRef.current;
    if (!canvas || !transformedPreview || !hasImageRect) return;
    canvas.width = transformedPreview.width;
    canvas.height = transformedPreview.height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(transformedPreview, 0, 0);
    if (lutShown && lutGradedTransformed.width === canvas.width && lutGradedTransformed.height === canvas.height) {
      context.globalAlpha = lutStrength;
      context.drawImage(lutGradedTransformed, 0, 0);
      context.globalAlpha = 1;
    }
  }, [transformedPreview, hasImageRect, composedActive, lutShown, lutGradedTransformed, lutStrength]);

  // Paint the depth field into a display canvas with the SAME intrinsic dimensions
  // as the source canvas. This way the two canvases share identical
  // intrinsic-to-CSS scaling and stay pixel-aligned at any zoom.
  useEffect(() => {
    if (!depthMapVisible) return;
    const canvas = depthOverlayCanvasRef.current;
    const depthCanvas = depthFieldCanvasRef.current;
    if (!canvas || !depthCanvas || !transformedPreview) return;
    canvas.width = transformedPreview.width;
    canvas.height = transformedPreview.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(depthCanvas, 0, 0, canvas.width, canvas.height);
  }, [depthMapVisible, depthFieldVersion, depthFieldCanvasRef, transformedPreview, composedActive]);


  // Layers are stored in full-photo coords and converted to the current display
  // basis at render (displayLayers, below) — pad/crop changes need no imperative
  // layer remap, and undo/redo can't drift them.

  // Refit the framed view when the stage or photo orientation changes under a
  // fixed viewTransform (window resize, quarter-turn) — review F5. At pad=0
  // getFitTransformForState is identity, so this is a no-op there.
  useEffect(() => {
    resetViewToFit(editorStateRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportSize.width, viewportSize.height, discreteRotationDeg]);

  function handleReset() {
    if (!baseSnapshotRef.current) return;
    // The crop panel's Reset is about the geometry; a chosen LUT stays.
    recordState({ ...cloneState(baseSnapshotRef.current), lut: editorStateRef.current.lut });
    setMessage("");
  }

  // The chosen LUT as a full-resolution step for the save and split paths:
  // the photo (cropped, not yet framed) in, the graded copy out. Null when
  // there is nothing to grade.
  const lutGrader = (lut) => (lut && lut.strength > 0
    ? (canvas) => gradeCanvas(canvas, lut.id, lut.strength, { parallel: fullSizeParallelism() })
    : null);

  // Save / export pipeline. buildSaveArgs assembles the full saveEditedImage
  // context from current state; the hook reads it through a ref so a backdoor
  // save after a transform runs against the latest state.
  const buildSaveArgs = (savePath) => ({
    savePath,
    sourcePath,
    // What the result is a version of. For a RAW that is the RAW, not the
    // preview the pixels came from — or the export comes out unlinked.
    originPath: saveBasePath,
    sourceImage,
    transformedPreview,
    rotationDeg,
    quarterTurns,
    freeAngle,
    flipX,
    flipY,
    normalizedCrop,
    canvasPad: editorState.canvas?.pad,
    canvasBg: editorState.canvas?.bg,
    canvasScrim: editorState.canvas?.scrim,
    layers,
    depthFieldCanvas: depthFieldCanvasRef.current,
    depthFeather,
    drawLayersToCtx: drawTextLayersOnCanvas,
    nativeSaveSourcePath: nativeSaveSourcePathRef.current,
    isLayerRenderable: (layer) => isTextLayer(layer) || isStickerLayer(layer) || isOverlayLayer(layer),
    gradeContent: lutGrader(editorStateRef.current.lut),
  });
  const { saving, executeSaveRef, handleExport, handleQuickSave } = useEditorSave({
    saveBasePath,
    buildSaveArgs,
    canSave: () => !!(cropRect && imageRect),
    quickSavePathRef,
    onSaveComplete,
    pushToast,
    t,
    onSaveStart: () => setMessage(""),
    joinFolder: folderJoin.joinFolder,
  });

  const splitExport = useSplitExport({
    saveBasePath, sourcePath, sourceImageRef, nativeSaveSourcePathRef, editorStateRef,
    getGrader: () => lutGrader(editorStateRef.current.lut),
    getCount: () => splitToolRef.current.count,
    pushToast, t,
    // No path: App refreshes the gallery; the split hook raises its own toast.
    onSaveComplete: () => onSaveComplete?.(),
    joinFolder: folderJoin.joinFolder,
  });
  const splitExportRef = useRef(null);
  splitExportRef.current = (outputDir = splitOutputDir, subfolder = splitSubfolder) => splitExport.exportSplit({ outputDir, subfolder });
  const splitExportingRef = useRef(false);
  splitExportingRef.current = splitExport.exporting;
  // Destination as of the latest render, for the e2e backdoor (its effect
  // does not re-run on destination changes).
  const splitDestRef = useRef(null);
  splitDestRef.current = { outputDir: splitOutputDir, subfolder: splitSubfolder };
  async function chooseSplitFolder() {
    const dir = await api.pickDirectory({ defaultPath: resolveSplitOutputDir(saveBasePath, splitOutputDir, false) || undefined });
    if (!dir) return;
    setSplitOutputDir(dir);
    writePref(SPLIT_DIR_PREF, dir);
  }
  function splitNextToOriginal() {
    setSplitOutputDir(null);
    clearPref(SPLIT_DIR_PREF);
  }
  function chooseSplitSubfolder(next) {
    setSplitSubfolder(next);
    writePref(SPLIT_SUBFOLDER_PREF, next);
  }

  // Frame presets — their own module so EditorOverlay stays the orchestrator.
  // Presets are generated on the cropped/transformed photo and applied as
  // editable layers + canvas margins (unified canvas model).
  const frameTool = useFrameTool({
    active: tool === "frame",
    item,
    transformedPreview,
    normalizedCrop,
  });
  // Fresh handle to the frame tool for the e2e backdoor (frameTool is a new
  // object each render; the backdoor effect's deps don't track it).
  const frameToolRef = useRef(null);
  frameToolRef.current = frameTool;

  // Apply a frame preset (`res` from generatePresetLayers) or clear it (res=null)
  // as ONE atomic history entry: set canvas margins/bg/scrim AND replace the
  // preset's layers (keeping the user's own, re-expressed into the new basis)
  // together, so a single undo reverses the whole preset. Crop and zoom/offset
  // stay untouched — the composed output view wraps the CROPPED photo. Sets
  // layerBasisRef so the basis-sync effect treats the fresh head as current.
  function setCanvasPreset(res) {
    const s = editorStateRef.current;
    const nextPad = res ? res.pad : { top: 0, right: 0, bottom: 0, left: 0 };
    const nextState = res
      ? { ...s, canvas: { pad: res.pad, bg: res.bg, scrim: null } }
      : { ...s, canvas: { ...s.canvas, pad: nextPad, bg: null, scrim: null } };
    // Layers are full-photo coords, basis-independent — the user's own layers
    // stay put; the preset's generated layers already arrive in full-photo coords.
    // Re-applying a preset REPLACES the previous preset's layers (don't stack).
    const cur = currentLayerHead().filter((l) => !l.fromPreset);
    if (res?.stickerImages) {
      for (const [src, img] of res.stickerImages) stickerImageCache.set(src, img);
    }
    // Apply state + layers live, then commit a single combined (atomic) entry.
    const presetOverlay = res?.scrim
      ? createOverlayLayer({ ...res.scrim, sourceLabel: t("text.overlayLayer"), fromPreset: true })
      : null;
    applyState(nextState);
    // The preset scrim used to be canvas metadata beneath every layer. Keep
    // that visual order, but represent it as a normal editable stack item.
    applyLayers(res ? [...(presetOverlay ? [presetOverlay] : []), ...cur, ...res.layers] : cur);
    commitCurrent();
    resetViewToFit(nextState);
    setTool("frame");
  }

  async function applyFramePreset(tpl) {
    const res = await frameToolRef.current?.generatePresetLayers?.(tpl);
    if (res) setCanvasPreset(res);
  }

  function clearFramePreset() {
    setCanvasPreset(null);
  }

  // "My logo" into the frame. Where and at what size come from logoPlacement
  // (a bar's right end, or beside what is already there; the photo's corner
  // with no bar); a recolourable logo goes black on a light background and
  // white on a dark one; the others keep their colours.
  async function placePersonalLogo(logo) {
    const source = transformedPreview;
    if (!source || !logo) return;
    const s = editorStateRef.current;
    const pad = s.canvas?.pad || {};
    const fullW = source.width || source.naturalWidth;
    const fullH = source.height || source.naturalHeight;
    const geom = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad });
    const spot = placeLogo({
      geom, pad, aspect: logo.width / Math.max(1, logo.height),
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    let color = null;
    if (logo.tintable) {
      const light = spot.region === "photo" ? photoLightness(source, geom, spot) : backgroundLightness(s.canvas?.bg);
      color = light < 0.55 ? "#ffffff" : "#141414";
    }
    const img = await preparePersonalLogo(logo, color);
    stickerImageCache.set(img.src, img);
    const layer = createStickerLayer(
      { stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, sourceLabel: logo.name },
      {
        x: (spot.cx - geom.left + geom.cropX) / fullW,
        y: (spot.cy - geom.top + geom.cropY) / fullH,
        scale: spot.width / fullW,
        logoRef: { source: "personal", id: logo.id, color },
        fromPreset: true, // part of the frame
      },
    );
    commitLayers([...layersRef.current, layer]);
    setSelectedIds(new Set([layer.id]));
  }

  // One of the camera's logos into the frame: from the brand row (`level`
  // "brand": Sony's "symbol" α or its "wordmark", or the brand's logo of mine)
  // or the model row (its own logo), placed like my logos and coloured for
  // what is behind it. A template finds it again for the next photo's camera.
  async function placeCameraLogo({ level = "brand", variant } = {}) {
    const source = transformedPreview;
    const tool = frameToolRef.current;
    if (!source || !tool?.cameraLogo) return;
    const s = editorStateRef.current;
    const pad = s.canvas?.pad || {};
    const fullW = source.width || source.naturalWidth;
    const fullH = source.height || source.naturalHeight;
    const geom = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad });
    const ref = { variant: variant || "wordmark", kind: null, strict: false, color: "#141414", ...(level === "brand" ? { scope: "brand" } : {}) };
    const probe = await tool.brandLogoFor(ref);
    if (!probe) return;
    const spot = placeLogo({
      geom, pad, aspect: probe.naturalWidth / Math.max(1, probe.naturalHeight),
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    const light = spot.region === "photo" ? photoLightness(source, geom, spot) : backgroundLightness(s.canvas?.bg);
    if (light < 0.55) ref.color = "#ffffff";
    const img = (await tool.brandLogoFor(ref)) || probe;
    stickerImageCache.set(img.src, img);
    const layer = createStickerLayer(
      { stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, sourceLabel: await tool.cameraLogoLabel(level) },
      {
        x: (spot.cx - geom.left + geom.cropX) / fullW,
        y: (spot.cy - geom.top + geom.cropY) / fullH,
        scale: spot.width / fullW,
        logoRef: ref,
        fromPreset: true, // part of the frame
      },
    );
    commitLayers([...layersRef.current, layer]);
    setSelectedIds(new Set([layer.id]));
  }

  // Give the camera's brand, or just its model, one of my logos (null: take
  // that choice back). The
  // camera logos already in this frame follow, each keeping its end of the
  // bar and its weight (swapLogo); one with no logo now is taken out. A frame
  // that had none gets the new logo placed.
  async function chooseCameraLogo(logo, scope) {
    const tool = frameToolRef.current;
    if (!tool) return;
    const logoId = logo?.id || null;
    await tool.setCameraLogo(logoId, scope);
    const source = transformedPreview;
    if (!source) return;
    const fullW = source.width || source.naturalWidth;
    const fullH = source.height || source.naturalHeight;
    const geom = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad: editorStateRef.current.canvas?.pad || {} });
    const isCameraLogo = (layer) => layer.type === "sticker" && layer.logoRef && !isPersonalLogoRef(layer.logoRef);
    const layers = layersRef.current;
    if (!layers.some(isCameraLogo)) {
      if (logoId) await placeCameraLogo({ level: scope === "model" ? "model" : "brand" });
      return;
    }
    const labels = { brand: await frameToolRef.current.cameraLogoLabel("brand"), any: await frameToolRef.current.cameraLogoLabel() };
    const next = [];
    for (const layer of layers) {
      if (!isCameraLogo(layer)) { next.push(layer); continue; }
      const img = await frameToolRef.current.brandLogoFor(layer.logoRef);
      if (!img) continue;
      stickerImageCache.set(img.src, img);
      next.push({
        ...layer,
        ...swapLogo({ layer, geom, aspect: img.naturalWidth / Math.max(1, img.naturalHeight) }),
        stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        sourceLabel: layer.logoRef.scope === "brand" ? labels.brand : labels.any,
      });
    }
    commitLayers(next);
    setSelectedIds((ids) => new Set([...ids].filter((id) => next.some((l) => l.id === id))));
  }

  // Photo info or free text into the frame: a bar's left end (then its
  // centre, its right end), dark on a light background and light on a dark
  // one; with no bar, the photo's bottom-left corner. Returns whether there
  // was anything to add (a photo without a lens has no lens line).
  function addFrameText({ text, tokenSource = null, secondary = false }) {
    const source = transformedPreview;
    if (!source || !text) return false;
    const s = editorStateRef.current;
    const pad = s.canvas?.pad || {};
    const fullW = source.width || source.naturalWidth;
    const fullH = source.height || source.naturalHeight;
    const geom = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad });
    const family = FRAME_FONTS.grotesk;
    const widthAt = (fontPx) => measureTextWidthDOM(text, { fontPx, weight: 400, family });
    const spot = placeText({
      geom, pad, widthAt, scale: secondary ? 0.75 : 1,
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    const onPhoto = spot.region === "photo";
    const light = onPhoto
      ? photoLightness(source, geom, { cx: spot.cx, cy: spot.cy, width: widthAt(spot.fontPx), height: spot.fontPx * 1.2 })
      : backgroundLightness(s.canvas?.bg);
    const layer = createDefaultLayer({
      text, ...(tokenSource ? { tokenSource } : {}),
      fontFamily: family, fontWeight: 400, fontSize: (spot.fontPx * 1920) / fullW,
      fillColor: light < 0.55 ? "#f4f4f4" : "#1a1a1a",
      shadow: onPhoto, shadowColor: light < 0.55 ? "#000000" : "#ffffff",
      x: (spot.cx - geom.left + geom.cropX) / fullW,
      y: (spot.cy - geom.top + geom.cropY) / fullH,
      fromPreset: true, // part of the frame
    });
    commitLayers([...layersRef.current, layer]);
    setSelectedIds(new Set([layer.id]));
    return true;
  }

  // An SVG or PNG dragged in from Finder becomes one of my logos, placed at once.
  const [logoDropActive, setLogoDropActive] = useState(false);
  const canImportLogo = api.has("importPersonalLogo");
  async function handleLogoDrop(event) {
    setLogoDropActive(false);
    const files = [...(event.dataTransfer?.files || [])].filter((file) => /\.(svg|png)$/i.test(file.name));
    if (!canImportLogo || !files.length) return;
    event.preventDefault();
    for (const file of files) {
      const filePath = api.getPathForFile(file) || file.path;
      if (!filePath) continue;
      const res = await api.importPersonalLogo(filePath);
      if (res?.error) {
        pushToast?.({
          title: t(`border.logoErrors.${res.error}`, { message: res.message || "", defaultValue: t("border.logoErrors.failed", { message: res.error }) }),
          tone: "error", ttl: 6000,
        });
        continue;
      }
      if (!res?.logo) continue;
      invalidatePersonalLogos();
      setTool("frame");
      await placePersonalLogo(res.logo);
      pushToast?.({ title: t("border.logoImported"), message: res.logo.name, ttl: 3000 });
    }
  }

  // "Save as template": the look as it stands (margins, background, every
  // layer) becomes one of the user's frame templates.
  async function saveFrameTemplate(name) {
    const s = editorStateRef.current;
    try {
      // Only the frame: what is written on the photo stays with the photo.
      const res = await frameToolRef.current?.saveTemplate?.(name, {
        layers: layersRef.current.filter(isFrameLayer), pad: s.canvas?.pad || {}, bg: s.canvas?.bg || null,
      });
      if (!res) return;
      pushToast?.({
        title: t("border.templateSaved"),
        message: res.skipped ? t("border.templateSkipped", { count: res.skipped }) : name,
        ttl: res.skipped ? 7000 : 4000,
      });
    } catch (error) {
      pushToast?.({ title: t("border.templateFailed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
    }
  }

  // Test backdoor — let E2E specs drive the editor (save to a known path,
  // switch tools, read state …) without the native dialogs. The method table
  // is rebuilt every render so each closure sees the current state, and
  // installed once per open through the ref: re-installing on every state
  // change (the old shape) left gaps a polling spec could land in.
  const testApiRef = useRef(null);
  testApiRef.current = {
    // executeSave is itself kept in a ref (see executeSaveRef) so a backdoor
    // save after rotating never runs an older closure and saves unrotated.
    saveAs: (path) => executeSaveRef.current?.(path),
    // Preview decoded. 18-editor-transform polls this while it deliberately
    // holds back viewport measurements, so it must not imply a measured stage.
    getPreviewReady: () => previewReadyRef.current,
    // Ready to EDIT: preview decoded AND the initial snapshot is in history.
    // waitForEditor({ preview: true }) waits for this — on a slow runner the
    // viewport measures late, the base snapshot lands after the test's first
    // edit, and an undo at history index 0 is a no-op (CI 19-editor-layers,
    // 2026-09-17).
    getEditReady: () => previewReadyRef.current && !!baseSnapshotRef.current,
    getSaving: () => saving,
    sampleSourcePixel: (fx = 0.5, fy = 0.5) => {
      const source = sourceImageRef.current;
      const { width, height } = getSourceDimensions(source);
      if (!source || !width || !height) return null;
      const sample = document.createElement("canvas");
      sample.width = 1;
      sample.height = 1;
      const sx = Math.min(width - 1, Math.max(0, Math.round(fx * (width - 1))));
      const sy = Math.min(height - 1, Math.max(0, Math.round(fy * (height - 1))));
      sample.getContext("2d").drawImage(source, sx, sy, 1, 1, 0, 0, 1, 1);
      return [...sample.getContext("2d").getImageData(0, 0, 1, 1).data];
    },
    addTextLayer: (text) => addTextLayer(text),
    setTestLayers: (next) => commitLayers(next),
    loadTestDepth: (path) => loadDepthFromPath(path),
    getLayerCount: () => layers.length,
    getTool: () => tool,
    setTool: (t) => setTool(t),
    // Characterization backdoor for the refactor safety-net (Phase 0).
    getState: () => {
      const s = editorStateRef.current;
      return {
        tool,
        aspectKey: s.aspectKey,
        quarterTurns: s.quarterTurns,
        freeAngle: s.freeAngle,
        flipX: s.flipX,
        flipY: s.flipY,
        imageZoom: s.imageZoom,
        imageOffsetX: s.imageOffsetX,
        imageOffsetY: s.imageOffsetY,
        hasCrop: !!s.cropRect,
        cropRect: s.cropRect,
        // The crop as of the latest committed render — what buildSaveArgs
        // (and therefore a backdoor save) actually exports. `s.cropRect`
        // above is the ref, updated synchronously by record(); polling it can
        // pass a frame before the render that the save path reads.
        cropRectRendered: cropRect,
        // `layers` is the STORED (full-photo) basis; `displayLayers` is the
        // derived current-basis position shown on screen.
        layers: layers.map((l) => ({
          id: l.id, type: l.type, x: l.x, y: l.y, scale: l.scale,
          naturalWidth: l.naturalWidth, naturalHeight: l.naturalHeight,
          // Text styling the panel/gesture specs assert on.
          text: l.text, fontFamily: l.fontFamily, fontSize: l.fontSize, italic: l.italic, fillColor: l.fillColor, rotation: l.rotation,
          strokeEnabled: !!l.strokeEnabled, strokeWidth: l.strokeWidth, shadow: !!l.shadow, shadowX: l.shadowX, bgMode: l.bgMode,
          // Data URLs are megabytes — expose only the kind, not the payload.
          stickerPathKind: typeof l.stickerPath === "string"
            ? (l.stickerPath.startsWith("data:") ? "data" : "path")
            : null,
          logoRef: l.logoRef || null,
          handwriting: l.handwriting
            ? { text: l.handwriting.text, provider: l.handwriting.provider, styleId: l.handwriting.styleId }
            : null,
          // Overlay (蒙层) model: paint + where it covers.
          ...(l.type === "overlay" ? {
            fromPreset: !!l.fromPreset, mode: l.mode, opacity: l.opacity,
            edge: l.edge, coverage: l.coverage,
            gradientStops: l.gradient?.stops?.map((st) => ({ ...st })) || null,
            gradientAngle: l.gradient?.angle,
          } : {}),
        })),
        displayLayers: displayLayers.map((l) => ({ id: l.id, x: l.x, y: l.y })),
        selectedIds: [...selectedIds],
        historyIndex: historyIndexRef.current,
        historyLength: historyRef.current.length,
        canvasPad: s.canvas?.pad,
        imageRect,
        outputRect: screenOutputRect,
        outputContentRect: screenOutputView?.contentRect || null,
        viewTransform,
        placement,
        stageBounds: getStageBounds(viewportSize),
      };
    },
    setAspect: (key) => commitAspect(key),
    setPad: (pad) => {
      applyCanvasPad({ top: 0, right: 0, bottom: 0, left: 0, ...pad }, { record: true });
    },
    clearFramePreset: () => clearFramePreset(),
    applyFramePreset: (templateId) => {
      const tpl = frameToolRef.current?.templates?.find((x) => x.id === templateId);
      return tpl ? applyFramePreset(tpl) : undefined;
    },
    deleteLayer: (id) => handleDeleteLayer(id),
    moveLayer: (id, dir) => handleMoveLayer(id, dir),
    selectLayers: (ids) => selectLayers(ids),
    undo: () => handleUndo(),
    redo: () => handleRedo(),
    // LUT tool (docs/lut-plan.md).
    getLutState: () => ({
      lut: editorStateRef.current.lut,
      // Graded with the LUT chosen now (a switch shows the previous one
      // until the new grade lands).
      gradedReady: !!lutGradedTransformed && lutTool.gradedId === editorStateRef.current.lut?.id,
      grading: lutTool.grading,
      base: lutBase,
      sourcePath,
      library: lutTool.library
        ? {
            ...lutTool.library,
            luts: lutTool.library.luts.map((l) => ({
              id: l.id, name: l.name, group: l.group, source: l.source, log: l.log, error: l.error,
            })),
          }
        : null,
      errors: lutTool.errors,
      pool: lutPoolInfo(),
    }),
    refreshLuts: async () => {
      const next = await lutTool.refresh();
      return next?.luts?.length ?? 0;
    },
    setLut: (id, strength = 1) => {
      const s = editorStateRef.current;
      const entry = lutTool.library?.luts?.find((l) => l.id === id);
      recordState({ ...s, lut: id ? { id, name: entry?.name || id, strength } : null });
    },
    // The preview as drawn (graded at the current strength), 0..1 coords.
    sampleDisplayPixel: (fx = 0.5, fy = 0.5) => {
      const canvas = imageCanvasRef.current;
      if (!canvas?.width) return null;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * (canvas.width - 1))));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * (canvas.height - 1))));
      return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
    },
    // Split tool (read through refs so the values are always current).
    getSplitState: () => {
      const st = splitToolRef.current;
      return {
        aspectKey: st.aspectKey, count: st.count, isAutoCount: st.isAutoCount,
        rect: st.rect, rectPx: st.rectPx, splitImageRect: st.splitImageRect,
        custom: st.custom,
        outputDir: splitDestRef.current.outputDir, subfolder: splitDestRef.current.subfolder,
        resolvedOutputDir: resolveSplitOutputDir(saveBasePath, splitDestRef.current.outputDir, splitDestRef.current.subfolder),
        exporting: splitExportingRef.current,
      };
    },
    setSplitAspect: (key, custom) => splitToolRef.current.commitAspect(key, custom),
    setSplitSubfolder: (on) => setSplitSubfolder(!!on),
    setSplitCount: (n) => splitToolRef.current.commitCount(n),
    resetSplitRegion: () => splitToolRef.current.resetRegion(),
    exportSplit: (dir, subfolder) => splitExportRef.current?.(
      dir ?? splitDestRef.current.outputDir, subfolder ?? splitDestRef.current.subfolder,
    ),
  };

  useEffect(() => {
    if (!open) return undefined;
    const keys = Object.keys(testApiRef.current);
    const target = (window.__afterframeTest = window.__afterframeTest || {});
    for (const k of keys) target[k] = (...args) => testApiRef.current[k](...args);
    return () => {
      for (const k of keys) delete target[k];
    };
  }, [open]);

  const previewReadyRef = useRef(false);
  previewReadyRef.current = !!previewSource;

  function handleApply() {
    flushLayerCommit();
    if (!sourceImage || !cropRect || !imageRect) return;
    const normalized = normalizedCrop;
    if (!normalized) return;

    // Re-base layers to the baked photo BEFORE the source swaps: the cropped
    // content becomes the new full photo, so full-photo coords are re-expressed
    // relative to the crop sub-rect (review F4). Storage has no pad → pad {}.
    const bakedLayers = bakeLayersIntoCrop(currentLayerHead(), transformedPreview, normalized, {});

    // Promote the applied crop into the working source so subsequent saves use the edited base.
    const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
    // Quarter turns + flips give the basis imageRect / cropRect live in; the
    // free angle turns the photo under the axis-aligned crop box about the
    // box's centre, which is exactly what the crop UI shows (CSS rotate about
    // cropCenter). Fractions are taken unclamped: with a free angle the box
    // may legitimately reach past the unrotated photo's bounding box.
    const transformed = buildTransformedCanvas(
      sourceImage,
      sourceWidth,
      sourceHeight,
      discreteRotationDeg,
      flipX,
      flipY,
    );
    const sx = transformed.width / imageRect.width;
    const sy = transformed.height / imageRect.height;
    const cropPx = {
      x: (cropRect.x - imageRect.x) * sx,
      y: (cropRect.y - imageRect.y) * sy,
      width: cropRect.width * sx,
      height: cropRect.height * sy,
    };
    const cropped = cutRotatedCrop(transformed, cropPx, freeAngle);
    const cw = cropped.width;
    const ch = cropped.height;
    cropped.naturalWidth = cw;
    cropped.naturalHeight = ch;

    const nextPreview = buildPreviewSource(cropped);
    const previousSource = sourceImageRef.current;
    sourceImageRef.current = cropped;
    setSourceImage(cropped);
    setPreviewSource(nextPreview);
    nativeSaveSourcePathRef.current = null;
    // The LUT is not baked: it carries over onto the cropped picture.
    carryLutRef.current = editorStateRef.current.lut;
    setBakedItem(itemKey);
    releaseCanvasImage(previousSource);
    releaseCanvasImage(transformed);
    baseSnapshotRef.current = null; // force re-initialization
    quickSavePathRef.current = null; // reset quick-save path on new apply
    syncHistory([], -1);
    applyState(BASE_STATE);
    setViewTransform(IDENTITY_VIEW_TRANSFORM); // review F4: drop the old fit
    applyLayers(bakedLayers); // history was just wiped; initial-snapshot effect will record it
    setMessage("Applied");
  }

  // Shortcut handlers are effect events: they read whatever state is current
  // when a key arrives, while the listener itself is bound once per open.
  const onEditorKeyDown = useEffectEvent((event) => {
    if (event.defaultPrevented) return;
    if (shouldIgnoreKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) handleRedo();
      else handleUndo();
      return;
    }
    // Save (⌘S unless rebound in Settings → Keyboard Shortcuts).
    if (matchShortcut(event, ["editor"])?.id === "editor.save") {
      event.preventDefault();
      void handleQuickSave();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && layerTool && selectedIds.size > 0) {
      event.preventDefault();
      copySelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v" && layerTool) {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && layerTool && selectedIds.size > 0) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (tool === "split") void splitExportRef.current?.();
      else handleApply();
    }
    if (event.key === " ") {
      setSpacePressed(true);
    }
  });
  const onEditorKeyUp = useEffectEvent((event) => {
    if (shouldIgnoreKey(event)) return;
    if (event.key === " ") {
      setSpacePressed(false);
    }
  });
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => onEditorKeyDown(event);
    const handleKeyUp = (event) => onEditorKeyUp(event);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [open]);

  if (!open) return null;

  const edited = !stateEquals(editorState, baseSnapshotRef.current || BASE_STATE);
  // P1 split works on the plain photo: layers and canvas margins need the
  // composited path (docs/split-carousel-plan.md, P2).
  const splitBlockedReason = layers.length > 0 || padActive || editorState.canvas?.scrim
    ? t("split.layersBlocked")
    : null;
  const dimsLabel = (() => {
    if (!sourceImage || !imageRect) return null;
    // Scale between screen and source pixels: quarter turns only — the free
    // angle is a rotation about the crop centre and does not change scale.
    const radians = (discreteRotationDeg * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
    const nativeWidth = sourceWidth * absCos + sourceHeight * absSin;
    const scale = nativeWidth / imageRect.width;
    const dims = `${sourceWidth} × ${sourceHeight}`;
    if (tool === "split" && splitTool.rect && splitSourceDims) {
      const panelW = Math.round((splitTool.rect.width * splitSourceDims.width) / splitTool.count);
      const panelH = Math.round(splitTool.rect.height * splitSourceDims.height);
      return `· ${dims} · ${t("overlay.tools.split")} ${splitTool.count} × ${panelW} × ${panelH}`;
    }
    if (!showCropUi || !cropRect) return `· ${dims}`;
    const cropW = Math.round(cropRect.width * scale);
    const cropH = Math.round(cropRect.height * scale);
    return `· ${dims} · Crop ${cropW} × ${cropH}`;
  })();
  // Switching tools resets the depth-map debug overlay for every tool except
  // text (which owns the depth toggle).
  const selectTool = (next) => {
    setTool(next);
    if (next !== "text") setDepthMapVisible(false);
    // Text and Frame each edit their own layers: a selection that belongs to
    // the other tool is dropped on the way in.
    if (next === "text" || next === "frame") {
      const frame = next === "frame";
      setSelectedIds((ids) => new Set([...ids].filter((id) => isFrameLayer(layersRef.current.find((l) => l.id === id)) === frame)));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10100] flex flex-col bg-app text-text"
      onDragOver={(event) => {
        if (!canImportLogo || !isLogoFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!logoDropActive) setLogoDropActive(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setLogoDropActive(false); }}
      onDrop={handleLogoDrop}
    >
      {logoDropActive && (
        <div className="pointer-events-none absolute inset-0 z-[60] flex items-center justify-center bg-app/60" data-logo-drop-hint="true">
          <div className="rounded-xl border border-dashed border-border bg-chrome px-6 py-4 text-[13px] text-text shadow-overlay">
            {t("border.dropLogo")}
          </div>
        </div>
      )}
      <EditorHeader
        sourceLabel={sourceLabel}
        edited={edited}
        dimsLabel={dimsLabel}
        saving={saving}
        exportDisabled={saving || loadState !== "ready"}
        onExport={handleExport}
        folder={fileSaveFolder}
        addToFolder={folderJoin.addToFolder}
        onAddToFolderChange={folderJoin.setAddToFolder}
        onClose={onClose}
        t={t}
      />

      <div
        ref={viewportRef}
        data-editor-viewport="true"
        className="relative min-h-0 flex-1 overflow-hidden bg-app"
        style={{ cursor: spacePressed && tool !== "split" ? "grab" : activeInteraction === "rotate" ? "crosshair" : activeInteraction === "image-pan" ? "grabbing" : "default" }}
        onPointerDown={spacePressed && tool !== "split" ? beginImagePan : undefined}
        onPointerMove={viewportPointerMove}
        onPointerUp={viewportPointerEnd}
        onPointerCancel={viewportPointerEnd}
      >
        {/* Nothing drawn yet: the catalog's preview stands in, dimmed. */}
        {loadState === "loading" || lutBase === "rendering" ? (
          <EditorLoading
            previewPath={imageRect ? null : item?.preview_hd_path || item?.image_preview_hd_path || item?.image_preview_path || item?.preview_path || null}
            viewportSize={viewportSize}
            over={imageRect}
            label={isRaw && awaitingSource ? t("overlay.renderingRaw")
              : lutBase === "rendering" || (isRaw && neutralPath && !sourceBaked) ? t("lut.base.rendering")
              : t("overlay.loading")}
            hint={isRaw && awaitingSource ? t("overlay.renderingRawHint") : null}
          />
        ) : null}
        {loadState === "error" ? <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">{loadError || message || "Failed to load image"}</div> : null}

        {imageRect ? (
          <>
            {composedView ? (
              <>
                {/* Composed border view (text tool): bg-filled output canvas +
                    a clipping window showing the CROPPED photo inset by the
                    margins — mirrors exactly what saveImage renders. */}
                <div
                  className="absolute"
                  style={{
                    left: `${composedView.rect.x}px`, top: `${composedView.rect.y}px`,
                    width: `${composedView.rect.width}px`, height: `${composedView.rect.height}px`,
                    background: bgToCss(editorState.canvas?.bg),
                  }}
                />
                <div
                  className="absolute overflow-hidden"
                  style={{
                    left: `${composedView.contentRect.x}px`, top: `${composedView.contentRect.y}px`,
                    width: `${composedView.contentRect.width}px`, height: `${composedView.contentRect.height}px`,
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={freeAngle ? { transform: `rotate(${freeAngle}deg)` } : undefined}
                  >
                    <canvas
                      ref={imageCanvasRef}
                      className="absolute block select-none"
                      style={{
                        left: `${composedView.photoRect.x - composedView.contentRect.x}px`,
                        top: `${composedView.photoRect.y - composedView.contentRect.y}px`,
                        width: `${composedView.photoRect.width}px`,
                        height: `${composedView.photoRect.height}px`,
                      }}
                    />
                    {depthMapVisible && depthFieldImageRef.current && (
                      <canvas
                        ref={depthOverlayCanvasRef}
                        className="pointer-events-none absolute block select-none"
                        style={{
                          left: `${composedView.photoRect.x - composedView.contentRect.x}px`,
                          top: `${composedView.photoRect.y - composedView.contentRect.y}px`,
                          width: `${composedView.photoRect.width}px`,
                          height: `${composedView.photoRect.height}px`,
                          opacity: 0.7,
                        }}
                      />
                    )}
                  </div>
                </div>
              </>
            ) : (
              /* Rotating image layer — only the image rotates */
              <div
                className="absolute inset-0"
                style={(() => {
                  // Split: the photo turns about the REGION centre, matching the
                  // export (region cut as one crop with the free angle, then sliced).
                  const origin = tool === "split" ? splitCenter : cropCenter;
                  return origin ? { transform: `rotate(${freeAngle}deg)`, transformOrigin: `${origin.x}px ${origin.y}px` } : undefined;
                })()}
              >
                <canvas
                  ref={imageCanvasRef}
                  className="absolute block select-none"
                  style={{
                    left: `${screenImageRect.x}px`,
                    top: `${screenImageRect.y}px`,
                    width: `${screenImageRect.width}px`,
                    height: `${screenImageRect.height}px`,
                    cursor: tool === "split" ? "default" : spacePressed ? "grab" : activeInteraction === "image-pan" ? "grabbing" : "grab",
                  }}
                  onPointerDown={tool === "split" ? undefined : beginImagePan}
                />

                {/* Show depth map (debug overlay) — a canvas mirror of the source canvas.
                    Same intrinsic dimensions, same CSS rect, same parent transform → the two
                    share an identical compositor box and stay pixel-aligned at any zoom. */}
                {depthMapVisible && depthFieldImageRef.current && (
                  <canvas
                    ref={depthOverlayCanvasRef}
                    className="pointer-events-none absolute block select-none"
                    style={{
                      left: `${screenImageRect.x}px`,
                      top: `${screenImageRect.y}px`,
                      width: `${screenImageRect.width}px`,
                      height: `${screenImageRect.height}px`,
                      opacity: 0.7,
                    }}
                  />
                )}
              </div>
            )}

            {/* Layer stack — text groups + depth layers, in user-defined order.
                Wrappers use zIndex: auto so DOM order = paint order; later siblings paint on top.
                The side panel (z=20) and crop overlay (z=10) stay above the entire stack
                regardless of how many layers the user adds. */}
            {layerTool && (
              <div className="absolute inset-0 isolate">
                <TextCanvas
                  layers={displayLayers}
                  selectedIds={selectedIds}
                  imageRect={screenOutputRect || screenImageRect}
                  overlayRect={screenOutputView?.contentRect || screenImageRect}
                  depthMaskGeom={composedView ? {
                    sx: normalizedCrop?.x ?? 0, sy: normalizedCrop?.y ?? 0,
                    sw: normalizedCrop?.width ?? 1, sh: normalizedCrop?.height ?? 1,
                    dx: (composedView.contentRect.x - composedView.rect.x) / composedView.rect.width,
                    dy: (composedView.contentRect.y - composedView.rect.y) / composedView.rect.height,
                    dw: composedView.contentRect.width / composedView.rect.width,
                    dh: composedView.contentRect.height / composedView.rect.height,
                  } : null}
                  onSelectionChange={setSelectedIds}
                  onLayersChange={applyLayersDisplay}
                  onLayersCommit={commitCurrent}
                  isLocked={(layer) => isFrameLayer(layer) !== (tool === "frame")}
                  tool={tool}
                  depthFieldCanvas={depthFieldCanvasRef.current}
                  depthFieldVersion={depthFieldVersion}
                  depthFeather={depthFeather}
                  backgroundPanRect={screenOutputView?.contentRect || screenImageRect}
                  onBackgroundPointerDown={beginOutputViewPan}
                  onBackgroundDoubleClick={() => resetViewToFit()}
                />
              </div>
            )}

            {/* Sticker region — drag-to-draw marquee for limiting subject detection
                to a sub-rect when VisionKit can't find the subject in the full frame. */}
            {tool === "sticker" && imageRect && (
              <StickerRegionOverlay
                imageRect={imageRect}
                region={sticker.region}
                drag={sticker.drag}
                onDragChange={sticker.setDrag}
                onCommit={sticker.commit}
              />
            )}

            {showCropUi && (
              <CropOverlay
                cropRect={cropRect}
                viewportSize={viewportSize}
                onBeginResize={beginCropResize}
              />
            )}

            {tool === "split" && splitTool.rectPx && (
              <SplitOverlay
                rect={splitTool.rectPx}
                count={splitTool.count}
                viewportSize={viewportSize}
                onBeginResize={splitTool.beginResize}
                onBeginMove={splitTool.beginMove}
              />
            )}
          </>
        ) : null}


        <div className="pointer-events-none absolute right-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-3">
          <PanelChrome width={PANEL_WIDTH}>
            {tool === "crop" ? (
              <CropPanel
                t={t}
                aspectKey={aspectKey}
                onCommitAspect={commitAspect}
                quarterTurns={quarterTurns}
                flipX={flipX}
                flipY={flipY}
                onCommitTransform={commitTransform}
                imageZoom={imageZoom}
                minZoom={getMinZoomForCrop(cropRect, transformedPreview, placement, freeAngle)}
                onZoomChange={(value) => {
                  if (!transformedPreview || !placement) return;
                  const next = clampImagePlacement(
                    { ...editorStateRef.current, imageZoom: value },
                    transformedPreview,
                    placement,
                  );
                  recordState(next);
                }}
                onReset={handleReset}
                canReset={loadState === "ready"}
                onUndo={handleUndo}
                canUndo={historyIndex > 0}
                onRedo={handleRedo}
                canRedo={historyIndex >= 0 && historyIndex < history.length - 1}
                onApply={handleApply}
                canApply={loadState === "ready"}
              />
            ) : layerTool ? (
              <TextPanel
                layers={displayLayers}
                selectedIds={selectedIds}
                onLayersChange={commitLayersDisplay}
                onLayersCoalesced={commitLayersCoalescedDisplay}
                onSelectionChange={setSelectedIds}
                onApply={handleTextApply}
                onReset={layerReset}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={historyIndex > 0}
                canRedo={historyIndex >= 0 && historyIndex < history.length - 1}
                onDeleteLayer={handleDeleteLayer}
                hasSceneDepth={!!depthSourcePath}
                depthGenerating={depthGenerating}
                depthError={depthError}
                onComputeDepth={handleComputeDepth}
                onClearDepth={handleClearDepth}
                depthFeather={depthFeather}
                onDepthFeatherChange={setDepthFeather}
                depthMapVisible={depthMapVisible}
                onToggleDepthMap={setDepthMapVisible}
                depthModel={depthModel}
                onPickDepthModel={handlePickDepthModel}
                onResetDepthModel={handleResetDepthModel}
                framePresets={frameTool.templates}
                frameThumbs={frameTool.thumbs}
                frameCellAspect={frameTool.cellAspect}
                onApplyPreset={applyFramePreset}
                onClearPreset={clearFramePreset}
                onSaveTemplate={saveFrameTemplate}
                onRenameTemplate={(id, name) => frameTool.renameTemplate(id, name)}
                onDuplicateTemplate={(id, name) => frameTool.duplicateTemplate(id, name)}
                onDeleteTemplate={(id) => frameTool.deleteTemplate(id)}
                mode={tool}
                onAddFrameInfo={(key, tokenSource) => addFrameText({
                  text: frameTool.resolveSource(tokenSource), tokenSource, secondary: key === "lens_model" || key === "exif",
                })}
                onAddFrameText={() => addFrameText({ text: t("frame.newText") })}
                onPlaceLogo={(logo) => placePersonalLogo(logo)}
                cameraLogo={frameTool.cameraLogo}
                onPlaceCameraLogo={(mark) => placeCameraLogo(mark)}
                onChooseCameraLogo={(logo, scope) => chooseCameraLogo(logo, scope)}
                canvasPad={editorState.canvas?.pad}
                canvasBg={editorState.canvas?.bg}
                onCanvasPad={(patch) => {
                  // Live (no history) while dragging the slider — keeps it smooth.
                  const s = editorStateRef.current;
                  applyCanvasPad({ ...s.canvas.pad, ...patch });
                }}
                onCanvasPadCommit={() => recordState(editorStateRef.current)}
                onCanvasBg={(nextBg) => {
                  const s = editorStateRef.current;
                  recordState({ ...s, canvas: { ...s.canvas, bg: nextBg } });
                }}
              />
            ) : tool === "split" ? (
              <SplitPanel
                t={t}
                aspectKey={splitTool.aspectKey}
                customAspect={splitTool.custom}
                onCommitAspect={splitTool.commitAspect}
                count={splitTool.count}
                isAutoCount={splitTool.isAutoCount}
                onCommitCount={splitTool.commitCount}
                rect={splitTool.rect}
                previewSource={transformedPreview}
                sourceDims={splitSourceDims}
                onResetRegion={splitTool.resetRegion}
                outputDir={resolveSplitOutputDir(saveBasePath, splitOutputDir, splitSubfolder)}
                subfolder={splitSubfolder}
                onSubfolderChange={chooseSplitSubfolder}
                onChooseFolder={chooseSplitFolder}
                onUseOriginalFolder={splitOutputDir ? splitNextToOriginal : null}
                folder={fileSaveFolder}
                addToFolder={folderJoin.addToFolder}
                onAddToFolderChange={folderJoin.setAddToFolder}
                blockedReason={splitBlockedReason}
                exporting={splitExport.exporting}
                progress={splitExport.progress}
                onExport={() => splitExportRef.current?.()}
                onUndo={handleUndo}
                canUndo={historyIndex > 0}
                onRedo={handleRedo}
                canRedo={historyIndex >= 0 && historyIndex < history.length - 1}
              />
            ) : tool === "lut" ? (
              <LutPanel
                t={t}
                tool={lutTool}
                lut={lutState}
                base={lutBase}
                onUndo={handleUndo}
                canUndo={historyIndex > 0}
                onRedo={handleRedo}
                canRedo={historyIndex >= 0 && historyIndex < history.length - 1}
              />
            ) : tool === "sticker" ? (
              <div className="flex max-h-[calc(100vh-10rem)] flex-col overflow-hidden">
                <StickerPanel
                  sourcePath={sourcePath}
                  sourceLabel={sourceLabel}
                  pushToast={pushToast}
                  region={sticker.region}
                  onClearRegion={sticker.clear}
                />
              </div>
            ) : null}
            {/* Always mounted so data loads when editor opens, hidden when not active */}
            <div className={tool === "ai" ? "flex max-h-[calc(100vh-10rem)] flex-col" : "hidden"}>
              <AiRepaintPanel
                sourcePath={sourcePath}
                outputBasePath={saveBasePath}
                onCompareChange={setCompareState}
                compareState={compareState}
                onRepaintComplete={onSaveComplete}
                folder={folderJoin.folder}
                addToFolder={folderJoin.addToFolder}
                onAddToFolderChange={folderJoin.setAddToFolder}
                targetCollectionId={folderJoin.targetCollectionId}
              />
            </div>
          </PanelChrome>

          <ToolRail tool={tool} onSelect={selectTool} t={t} />
        </div>

        {showCropUi ? (
          <AngleRuler
            value={freeAngle}
            viewportWidth={viewportSize.width}
            viewportHeight={viewportSize.height}
            centerX={placement?.centerX ?? (CANVAS_SIDE_PADDING + Math.max(200, viewportSize.width - PANEL_WIDTH - PANEL_GAP - CANVAS_SIDE_PADDING * 2) / 2 - 26)}
            onChangeStart={beginAngleDrag}
            onChange={updateAngle}
            onChangeEnd={endAngleDrag}
          />
        ) : null}

        {/* Compare overlay rendered outside viewport */}
      </div>

      {compareState?.afterPath && sourcePath ? (
        <BeforeAfterCompare
          beforePath={sourcePath}
          afterPath={compareState.afterPath}
          layout={compareState.layout}
          onClose={() => setCompareState(null)}
          onLayoutChange={(layout) => setCompareState((s) => s ? { ...s, layout } : s)}
        />
      ) : null}
    </div>
  );
}
