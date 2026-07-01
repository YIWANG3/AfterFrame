import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileName } from "../utils/format";
import { resizeCropRect, MIN_FREE_ANGLE, MAX_FREE_ANGLE } from "./editor/cropMath";
import AiRepaintPanel from "./editor/AiRepaintPanel";
import BeforeAfterCompare from "./editor/BeforeAfterCompare";
import TextPanel from "./editor/TextPanel";
import TextCanvas from "./editor/TextCanvas";
import StickerPanel from "./editor/StickerPanel";
import FramePanel from "./editor/FramePanel";
import FrameStage from "./editor/components/FrameStage";
import { useFrameTool } from "./editor/state/useFrameTool";
import { getBgPadding } from "./editor/textState";
import {
  hexToRgba,
  getSourceDimensions,
  releaseCanvasImage,
  buildPreviewSource,
  buildDepthMaskCanvas,
  buildTransformedCanvas,
  inferMimeType,
  canvasToBlob,
} from "./editor/render/canvasHelpers";
import { drawLayersOnCanvas } from "./editor/render/drawLayers";
import StickerRegionOverlay from "./editor/components/StickerRegionOverlay";
import EditorHeader from "./editor/components/EditorHeader";
import ToolRail from "./editor/components/ToolRail";
import PanelChrome from "./editor/components/PanelChrome";
import CropPanel from "./editor/components/CropPanel";
import CropOverlay from "./editor/components/CropOverlay";
import { BASE_STATE, cloneState, stateEquals } from "./editor/state/editorStateModel";
import { useEditorHistory } from "./editor/state/useEditorHistory";
import { useEditorImage } from "./editor/state/useEditorImage";
import { useEditorViewport } from "./editor/state/useEditorViewport";
import { useEditorSave } from "./editor/state/useEditorSave";
import { useCropTool } from "./editor/state/useCropTool";
import { useTextTool } from "./editor/state/useTextTool";
import { useStickerTool } from "./editor/state/useStickerTool";
import { useDepthModel } from "./editor/state/useDepthModel";
import { useLayerHistory } from "./editor/state/useLayerHistory";
import { useSceneDepth } from "./editor/state/useSceneDepth";
import {
  PANEL_WIDTH,
  PANEL_GAP,
  CANVAS_SIDE_PADDING,
  getStageBounds,
  getBasePlacement,
  getMinZoomForCrop,
  getImageRect,
  clampImagePlacement,
} from "./editor/imageMath";
import {
  isTextLayer,
  isStickerLayer,
  getTextLayers,
} from "./editor/layerStack";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createInitialSnapshot(viewportSize, transformedPreview) {
  const placement = getBasePlacement(viewportSize, transformedPreview);
  const baseState = {
    ...BASE_STATE,
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


function AngleRuler({ value, viewportWidth, viewportHeight, centerX, onChangeStart, onChange, onChangeEnd }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  const RULER_W = 600;
  const TICK_RANGE = 45;
  const PX_PER_DEG = RULER_W / (TICK_RANGE * 2);

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

export default function EditorOverlay({ open, item, onClose, onSaveComplete, pushToast }) {
  const { t } = useTranslation("editor");
  const imageCanvasRef = useRef(null);
  const depthOverlayCanvasRef = useRef(null);
  const nativeSaveSourcePathRef = useRef(null);
  const quickSavePathRef = useRef(null);
  // Transform state machine + undo/redo (destructured with original names so the
  // many call sites are unchanged).
  const {
    editorState, editorStateRef,
    history, historyIndex, historyRef, historyIndexRef, baseSnapshotRef,
    syncHistory, apply: applyState, record: recordState, commitCurrent, undo: handleUndo, redo: handleRedo,
  } = useEditorHistory();
  const [pointerPoint, setPointerPoint] = useState(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [tool, setTool] = useState("crop");
  const [message, setMessage] = useState("");
  const [compareState, setCompareState] = useState(null); // { afterPath, layout: "side"|"stack" }
  const layerHistory = useLayerHistory();
  const { layers, setLayers, historyRef: layerHistoryRef, indexRef: layerHistoryIndexRef } = layerHistory;
  // Text tool — selection + clipboard + layer CRUD (destructured with the
  // original names so call sites are unchanged).
  const {
    selectedIds, setSelectedIds,
    moveLayer: handleMoveLayer, deleteLayer: handleDeleteLayer,
    addTextLayer, selectLayers, copySelection, pasteClipboard, deleteSelection,
  } = useTextTool({ layers, layerHistory });
  // Scene-level depth: one Depth Anything V2 inference per source image,
  // cached as both an Image (for visualization) and a Canvas (for pixel reads).
  // RAW originals (.cr3/.3fr/…) can't be decoded by the renderer or sharp, so
  // edit from the full-res HD preview generated on import. The save target still
  // derives from the original path (saveBasePath) → edits land next to the
  // source file as <stem>_edited.jpg, not in the catalog previews dir.
  const isRaw = item?.asset_type === "raw";
  const sourcePath = (isRaw
    ? (item?.preview_hd_path || item?.image_preview_hd_path || item?.image_preview_path || item?.preview_path)
    : item?.image_path) || item?.image_preview_path || item?.raw_preview_path || null;
  const saveBasePath = item?.image_path || sourcePath;
  // Image load lives in its own hook. `setSourceImage`/`setPreviewSource` + the
  // ref are exposed so Apply/Text-apply can promote a freshly baked canvas.
  const {
    sourceImage, previewSource, loadState, loadError, sourceImageRef,
    setSourceImage, setPreviewSource,
  } = useEditorImage({ open, sourcePath, decodeErrorLabel: t("overlay.decodeError") });
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

  const sourceLabel = fileName(sourcePath) || item?.stem || "Selected asset";
  const {
    aspectKey,
    freeAngle,
    quarterTurns,
    flipX,
    flipY,
    cropRect,
    imageZoom,
    imageOffsetX,
    imageOffsetY,
  } = editorState;
  const discreteRotationDeg = quarterTurns * 90;
  const rotationDeg = discreteRotationDeg + freeAngle;
  const showCropUi = tool === "crop";
  const panelMeta = tool === "crop"
    ? { title: t("overlay.tools.crop"), badge: null }
    : tool === "ai"
      ? { title: t("overlay.tools.repaint"), badge: null }
      : tool === "text"
        ? { title: t("overlay.tools.text"), badge: null }
        : tool === "sticker"
          ? { title: t("overlay.tools.sticker"), badge: null }
          : tool === "frame"
            ? { title: t("overlay.tools.frame"), badge: null }
            : { title: "", badge: null };

  const commitLayers = layerHistory.commit;
  const layerUndo = layerHistory.undo;
  const layerRedo = layerHistory.redo;
  function layerReset() {
    layerHistory.reset();
    setSelectedIds(new Set());
    clearSceneDepth();
  }
  function layerResetHard() {
    layerHistory.resetHard();
    setSelectedIds(new Set());
    clearSceneDepth();
  }


  // Thin wrapper around the pure layer renderer that supplies the sticker
  // image cache from our closure.
  function drawTextLayersOnCanvas(ctx, canvasWidth, canvasHeight, layersToRender) {
    drawLayersOnCanvas(ctx, canvasWidth, canvasHeight, layersToRender, stickerImageCache);
  }


  function handleTextApply() {
    const renderable = layers.filter((l) => isTextLayer(l) || isStickerLayer(l));
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
    for (const layer of renderable) {
      const useDepth = depthCanvas && layer.zPosition != null && layer.zPosition < 1;
      if (!useDepth) {
        drawTextLayersOnCanvas(ctx, sw, sh, [layer]);
        continue;
      }
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      drawTextLayersOnCanvas(tmp.getContext("2d"), sw, sh, [layer]);
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
    releaseCanvasImage(previousSource);
    baseSnapshotRef.current = null;
    quickSavePathRef.current = null;
    syncHistory([], -1);
    applyState(BASE_STATE);
    layerResetHard();
    setMessage("Text applied");
  }

  // Reset editor state for a new source image (the image load itself lives in
  // useEditorImage). Also kicks off a cached-depth lookup for this source.
  useEffect(() => {
    if (!open || !sourcePath) return undefined;
    let active = true;
    setTool("crop");
    setMessage("");
    setCompareState(null);
    setDepthError(null);
    baseSnapshotRef.current = null;
    quickSavePathRef.current = null;
    nativeSaveSourcePathRef.current = sourcePath;
    syncHistory([], -1);
    applyState(BASE_STATE);
    layerResetHard();

    // Auto-load cached depth if it exists for this source image. Same image
    // (path + size + mtime) hits the cache; no ML inference.
    if (window.mediaWorkspace?.computeDepth) {
      window.mediaWorkspace.computeDepth({ sourcePath, checkOnly: true })
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

  // Viewport geometry (ref, measured size, placement, image rect, coord mapping).
  const { viewportRef, viewportSize, placement, imageRect, pointFromClient } =
    useEditorViewport({ open, transformedPreview, editorState });

  // Once the preview + viewport are ready, seed the initial centered-crop
  // snapshot (also the "Reset" target). Stays here — it records into history.
  useEffect(() => {
    if (!transformedPreview || !placement || baseSnapshotRef.current) return;
    const initial = createInitialSnapshot(viewportSize, transformedPreview);
    baseSnapshotRef.current = cloneState(initial);
    recordState(initial);
  }, [placement, transformedPreview, viewportSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const cropCenter = cropRect
    ? {
        x: cropRect.x + cropRect.width / 2,
        y: cropRect.y + cropRect.height / 2,
      }
    : null;

  // Crop / transform tool — pointer interactions + commit ops. Owns
  // activeInteraction (cursor) and the in-flight pointer/angle drag state.
  const {
    activeInteraction,
    commitAspect, commitTransform,
    beginCropResize, beginRotate, beginImagePan,
    handlePointerMove, handlePointerEnd,
    beginAngleDrag, updateAngle, endAngleDrag,
  } = useCropTool({
    open, previewSource, transformedPreview, viewportSize, placement, imageRect,
    viewportRef, editorState, editorStateRef, pointFromClient,
    apply: applyState, record: recordState, commitCurrent,
  });

  useEffect(() => {
    const canvas = imageCanvasRef.current;
    if (!canvas || !transformedPreview || !imageRect) return;
    canvas.width = transformedPreview.width;
    canvas.height = transformedPreview.height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(transformedPreview, 0, 0);
  }, [transformedPreview, imageRect]);

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
  }, [depthMapVisible, depthFieldVersion, transformedPreview]);


  function handleReset() {
    if (!baseSnapshotRef.current) return;
    recordState(baseSnapshotRef.current);
    setMessage("");
  }

  function getNormalizedCrop() {
    if (!cropRect || !imageRect) return null;
    return {
      x: clamp((cropRect.x - imageRect.x) / imageRect.width, 0, 1),
      y: clamp((cropRect.y - imageRect.y) / imageRect.height, 0, 1),
      width: clamp(cropRect.width / imageRect.width, 0, 1),
      height: clamp(cropRect.height / imageRect.height, 0, 1),
    };
  }

  // Save / export pipeline. buildSaveArgs assembles the full saveEditedImage
  // context from current state; the hook reads it through a ref so a backdoor
  // save after a transform runs against the latest state.
  const buildSaveArgs = (savePath) => ({
    savePath,
    sourcePath,
    sourceImage,
    transformedPreview,
    rotationDeg,
    quarterTurns,
    freeAngle,
    flipX,
    flipY,
    normalizedCrop: getNormalizedCrop(),
    layers,
    depthFieldCanvas: depthFieldCanvasRef.current,
    depthFeather,
    drawLayersToCtx: drawTextLayersOnCanvas,
    nativeSaveSourcePath: nativeSaveSourcePathRef.current,
    isLayerRenderable: (layer) => isTextLayer(layer) || isStickerLayer(layer),
  });
  const { saving, executeSave, executeSaveRef, handleExport, handleQuickSave } = useEditorSave({
    saveBasePath,
    buildSaveArgs,
    canSave: () => !!(cropRect && imageRect),
    quickSavePathRef,
    onSaveComplete,
    pushToast,
    t,
    onSaveStart: () => setMessage(""),
  });

  // Frame tool (5th tool) — its own module so EditorOverlay stays the
  // orchestrator. Frames the cropped/transformed photo; renders its own preview
  // surface (FrameStage) since the frame expands the canvas.
  const frameTool = useFrameTool({
    active: tool === "frame",
    item,
    transformedPreview,
    // Full-res source (+ its transforms) so export isn't capped at the 2200px preview.
    sourceImage,
    rotationDeg: discreteRotationDeg,
    flipX,
    flipY,
    normalizedCrop: getNormalizedCrop(),
    saveBasePath,
    pushToast,
    onSaveComplete,
  });
  // Fresh handle to the frame tool for the e2e backdoor (frameTool is a new
  // object each render; the backdoor effect's deps don't track it).
  const frameToolRef = useRef(null);
  frameToolRef.current = frameTool;

  // Test backdoor — let E2E specs trigger save to a known path without
  // driving the native save-as dialog. Registered while the editor is open.
  useEffect(() => {
    if (!open) return;
    window.__afterframeTest = {
      ...(window.__afterframeTest || {}),
      // Through a ref: the effect's dep list doesn't include every piece of
      // edit state (quarterTurns, crop …), so a direct closure goes stale —
      // a backdoor save after rotating would silently save unrotated.
      saveAs: (path) => executeSaveRef.current?.(path),
      // Tests must wait for this before transform clicks — commitTransform
      // aborts while the preview image is still decoding.
      getPreviewReady: () => previewReadyRef.current,
      getSaving: () => saving,
      addTextLayer: (text) => addTextLayer(text),
      getLayerCount: () => layers.length,
      getTool: () => tool,
      setTool: (t) => setTool(t),
      // Characterization backdoor for the refactor safety-net (Phase 0). Reads
      // via refs so it stays fresh regardless of this effect's deps.
      getState: () => {
        const s = editorStateRef.current;
        return {
          tool,
          aspectKey: s.aspectKey,
          quarterTurns: s.quarterTurns,
          freeAngle: s.freeAngle,
          flipX: s.flipX,
          flipY: s.flipY,
          hasCrop: !!s.cropRect,
          layers: layers.map((l) => ({ id: l.id, type: l.type, x: l.x, y: l.y, scale: l.scale })),
          selectedIds: [...selectedIds],
          historyIndex: historyIndexRef.current,
          historyLength: historyRef.current.length,
        };
      },
      setAspect: (key) => commitAspect(key),
      deleteLayer: (id) => handleDeleteLayer(id),
      moveLayer: (id, dir) => handleMoveLayer(id, dir),
      selectLayers: (ids) => selectLayers(ids),
      undo: () => handleUndo(),
      redo: () => handleRedo(),
      exportFrame: (savePath) => frameToolRef.current?.exportTo?.(savePath),
    };
    return () => {
      if (window.__afterframeTest) {
        for (const k of [
          "saveAs", "getPreviewReady", "getSaving", "addTextLayer", "getLayerCount",
          "getTool", "setTool", "getState", "setAspect", "deleteLayer", "moveLayer",
          "selectLayers", "undo", "redo", "exportFrame",
        ]) delete window.__afterframeTest[k];
      }
    };
  }, [open, saving, layers, tool, selectedIds]);

  const previewReadyRef = useRef(false);
  previewReadyRef.current = !!previewSource;

  function handleApply() {
    if (!sourceImage || !cropRect || !imageRect) return;
    const normalized = getNormalizedCrop();
    if (!normalized) return;

    // Promote the applied crop into the working source so subsequent saves use the edited base.
    const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
    const transformed = buildTransformedCanvas(
      sourceImage,
      sourceWidth,
      sourceHeight,
      rotationDeg,
      flipX,
      flipY,
    );

    const cx = Math.round(normalized.x * transformed.width);
    const cy = Math.round(normalized.y * transformed.height);
    const cw = Math.max(1, Math.round(normalized.width * transformed.width));
    const ch = Math.max(1, Math.round(normalized.height * transformed.height));

    const cropped = document.createElement("canvas");
    cropped.width = cw;
    cropped.height = ch;
    cropped.naturalWidth = cw;
    cropped.naturalHeight = ch;
    const ctx = cropped.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(transformed, cx, cy, cw, ch, 0, 0, cw, ch);

    const nextPreview = buildPreviewSource(cropped);
    const previousSource = sourceImageRef.current;
    sourceImageRef.current = cropped;
    setSourceImage(cropped);
    setPreviewSource(nextPreview);
    nativeSaveSourcePathRef.current = null;
    releaseCanvasImage(previousSource);
    releaseCanvasImage(transformed);
    baseSnapshotRef.current = null; // force re-initialization
    quickSavePathRef.current = null; // reset quick-save path on new apply
    syncHistory([], -1);
    applyState(BASE_STATE);
    setMessage("Applied");
  }

  useEffect(() => {
    if (!open) return undefined;
    function shouldIgnoreKey(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName;
      return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
    }

    function handleKeyDown(event) {
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleQuickSave();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && tool === "text" && selectedIds.size > 0) {
        event.preventDefault();
        copySelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v" && tool === "text") {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && tool === "text" && selectedIds.size > 0) {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        handleApply();
      }
      if (event.key === " ") {
        setSpacePressed(true);
      }
    }
    function handleKeyUp(event) {
      if (shouldIgnoreKey(event)) return;
      if (event.key === " ") {
        setSpacePressed(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [open, onClose, saving, rotationDeg, flipX, flipY, sourceImage, cropRect, imageRect, transformedPreview, tool, selectedIds, layers]);

  if (!open) return null;

  const edited = !stateEquals(editorState, baseSnapshotRef.current || BASE_STATE);
  const dimsLabel = (() => {
    if (!sourceImage || !imageRect) return null;
    const radians = (rotationDeg * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
    const nativeWidth = sourceWidth * absCos + sourceHeight * absSin;
    const scale = nativeWidth / imageRect.width;
    const dims = `${sourceWidth} × ${sourceHeight}`;
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
  };

  return (
    <div className="fixed inset-0 z-[10100] flex flex-col bg-app text-text">
      <EditorHeader
        sourceLabel={sourceLabel}
        edited={edited}
        dimsLabel={dimsLabel}
        saving={saving}
        exportDisabled={saving || loadState !== "ready"}
        onExport={handleExport}
        onClose={onClose}
        t={t}
      />

      <div
        ref={viewportRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-app"
        style={{ cursor: spacePressed ? "grab" : activeInteraction === "rotate" ? "crosshair" : activeInteraction === "image-pan" ? "grabbing" : "default" }}
        onPointerDown={spacePressed ? beginImagePan : undefined}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {loadState === "loading" ? <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">{t("overlay.loading")}</div> : null}
        {loadState === "error" ? <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">{loadError || message || "Failed to load image"}</div> : null}

        {imageRect ? (
          <>
            {/* Rotating image layer — only the image rotates */}
            <div
              className="absolute inset-0"
              style={cropCenter ? { transform: `rotate(${freeAngle}deg)`, transformOrigin: `${cropCenter.x}px ${cropCenter.y}px` } : undefined}
            >
              <canvas
                ref={imageCanvasRef}
                className="absolute block select-none"
                style={{
                  left: `${imageRect.x}px`,
                  top: `${imageRect.y}px`,
                  width: `${imageRect.width}px`,
                  height: `${imageRect.height}px`,
                  cursor: spacePressed ? "grab" : activeInteraction === "image-pan" ? "grabbing" : "grab",
                }}
                onPointerDown={beginImagePan}
              />

              {/* Show depth map (debug overlay) — a canvas mirror of the source canvas.
                  Same intrinsic dimensions, same CSS rect, same parent transform → the two
                  share an identical compositor box and stay pixel-aligned at any zoom. */}
              {depthMapVisible && depthFieldImageRef.current && (
                <canvas
                  ref={depthOverlayCanvasRef}
                  className="pointer-events-none absolute block select-none"
                  style={{
                    left: `${imageRect.x}px`,
                    top: `${imageRect.y}px`,
                    width: `${imageRect.width}px`,
                    height: `${imageRect.height}px`,
                    opacity: 0.7,
                  }}
                />
              )}
            </div>

            {/* Layer stack — text groups + depth layers, in user-defined order.
                Wrappers use zIndex: auto so DOM order = paint order; later siblings paint on top.
                The side panel (z=20) and crop overlay (z=10) stay above the entire stack
                regardless of how many layers the user adds. */}
            {tool === "text" && (
              <div className="absolute inset-0 isolate">
                <TextCanvas
                  layers={layers}
                  selectedIds={selectedIds}
                  imageRect={imageRect}
                  onSelectionChange={setSelectedIds}
                  onLayersChange={(updated) => {
                    const byId = new Map(updated.map((l) => [l.id, l]));
                    commitLayers(layers.map((l) => byId.get(l.id) || l));
                  }}
                  tool={tool}
                  depthFieldCanvas={depthFieldCanvasRef.current}
                  depthFieldVersion={depthFieldVersion}
                  depthFeather={depthFeather}
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
          </>
        ) : null}

        {tool === "frame" && (
          <FrameStage
            canvas={frameTool.framedCanvas}
            rendering={frameTool.rendering}
            rightInset={PANEL_WIDTH + PANEL_GAP + 72}
          />
        )}

        <div className="pointer-events-none absolute right-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-3">
          <PanelChrome panelMeta={panelMeta} width={PANEL_WIDTH}>
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
                minZoom={getMinZoomForCrop(cropRect, transformedPreview, placement)}
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
            ) : tool === "text" ? (
              <TextPanel
                layers={layers}
                selectedIds={selectedIds}
                onLayersChange={commitLayers}
                onSelectionChange={setSelectedIds}
                onApply={handleTextApply}
                onReset={layerReset}
                onUndo={layerUndo}
                onRedo={layerRedo}
                canUndo={layerHistoryIndexRef.current > 0}
                canRedo={layerHistoryIndexRef.current < layerHistoryRef.current.length - 1}
                onMoveLayer={handleMoveLayer}
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
            ) : tool === "frame" ? (
              <FramePanel frameTool={frameTool} />
            ) : null}
            {/* Always mounted so data loads when editor opens, hidden when not active */}
            <div className={tool === "ai" ? "flex max-h-[calc(100vh-10rem)] flex-col" : "hidden"}>
              <AiRepaintPanel sourcePath={sourcePath} outputBasePath={saveBasePath} sourceLabel={sourceLabel} onCompareChange={setCompareState} compareState={compareState} onRepaintComplete={onSaveComplete} />
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
          layout={compareState.layout || "side"}
          onClose={() => setCompareState(null)}
          onLayoutChange={(layout) => setCompareState((s) => s ? { ...s, layout } : s)}
        />
      ) : null}
    </div>
  );
}
