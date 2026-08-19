import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileName } from "../utils/format";
import { resizeCropRect, MIN_FREE_ANGLE, MAX_FREE_ANGLE } from "./editor/cropMath";
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
  buildTransformedCanvas,
  inferMimeType,
  canvasToBlob,
  bgToCss,
} from "./editor/render/canvasHelpers";
import { drawLayersOnCanvas } from "./editor/render/drawLayers";
import { createOverlayLayer } from "./editor/textState";
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
import { useSceneDepth } from "./editor/state/useSceneDepth";
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
  getTextLayers,
} from "./editor/layerStack";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function padEquals(a, b) {
  const pa = { top: 0, right: 0, bottom: 0, left: 0, ...(a || {}) };
  const pb = { top: 0, right: 0, bottom: 0, left: 0, ...(b || {}) };
  return pa.top === pb.top && pa.right === pb.right && pa.bottom === pb.bottom && pa.left === pb.left;
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
  // Unified undo/redo: ONE timeline over both the transform state AND the layer
  // stack, so Cmd+Z and every panel Undo button reverse the same last action.
  const {
    editorState, editorStateRef,
    layers, layersRef,
    history, historyIndex, historyRef, historyIndexRef, baseSnapshotRef,
    syncHistory, apply: applyState, applyLayers, record: recordState, commitCurrent,
    commitLayers, commitLayersCoalesced, flushLayerCommit,
    undo: rawHandleUndo, redo: rawHandleRedo,
  } = useEditorHistory();
  const [pointerPoint, setPointerPoint] = useState(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [viewTransform, setViewTransform] = useState(IDENTITY_VIEW_TRANSFORM);
  const viewTransformRef = useRef(IDENTITY_VIEW_TRANSFORM);
  viewTransformRef.current = viewTransform;
  const [tool, setTool] = useState("crop");
  const [message, setMessage] = useState("");
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
          : { title: "", badge: null };

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
    flushLayerCommit(); // drop any pending layer scrub before wiping history
    syncHistory([], -1);
    applyState(BASE_STATE);
    setViewTransform(IDENTITY_VIEW_TRANSFORM); // review F7: don't carry a stale fit across photos
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

  // Viewport geometry (ref, measured size, placement, image rect, normalized
  // crop, composed output view, coord mapping).
  const { viewportRef, viewportSize, placement, imageRect, normalizedCrop, outputView, outputRect, pointFromClient } =
    useEditorViewport({ open, transformedPreview, editorState });

  // Once the preview + viewport are ready, seed the initial centered-crop
  // snapshot (also the "Reset" target). Stays here — it records into history.
  useEffect(() => {
    if (!transformedPreview || !placement || baseSnapshotRef.current) return;
    const initial = createInitialSnapshot(viewportSize, transformedPreview);
    baseSnapshotRef.current = cloneState(initial);
    recordState(initial);
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
    beginCropResize, beginRotate, beginImagePan,
    handlePointerMove, handlePointerEnd,
    beginAngleDrag, updateAngle, endAngleDrag,
    flushWheelCommit,
  } = useCropTool({
    open, previewSource, transformedPreview, viewportSize, placement, imageRect,
    viewportRef, editorState, editorStateRef, pointFromClient,
    apply: applyState, record: recordState, commitCurrent,
  });

  // The text tool with an active border renders the COMPOSED view (cropped
  // content + margins) via a clipping window; every other view is the plain
  // crop-space photo. The canvas element remounts when the mode flips, so the
  // draw effect keys on it too.
  const padActive = hasPad(editorState.canvas?.pad);
  const screenOutputView = tool === "text" ? transformOutputView(outputView, viewTransform) : outputView;
  const screenOutputRect = screenOutputView?.rect ?? null;
  const screenImageRect = tool === "text" ? (screenOutputView?.photoRect || imageRect) : imageRect;
  const composedView = tool === "text" && padActive && screenOutputView ? screenOutputView : null;

  useEffect(() => {
    const canvas = imageCanvasRef.current;
    if (!canvas || !transformedPreview || !imageRect) return;
    canvas.width = transformedPreview.width;
    canvas.height = transformedPreview.height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(transformedPreview, 0, 0);
  }, [transformedPreview, !!composedView]);

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
  }, [depthMapVisible, depthFieldVersion, transformedPreview, !!composedView]);


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
    recordState(baseSnapshotRef.current);
    setMessage("");
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

  // Frame presets — their own module so EditorOverlay stays the orchestrator.
  // Presets are generated on the cropped/transformed photo and applied as
  // editable layers + canvas margins (unified canvas model).
  const frameTool = useFrameTool({
    active: tool === "text",
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
    setTool("text");
  }

  async function applyFramePreset(tpl) {
    const res = await frameToolRef.current?.generatePresetLayers?.(tpl);
    if (res) setCanvasPreset(res);
  }

  function clearFramePreset() {
    setCanvasPreset(null);
  }

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
          imageZoom: s.imageZoom,
          imageOffsetX: s.imageOffsetX,
          imageOffsetY: s.imageOffsetY,
          hasCrop: !!s.cropRect,
          cropRect: s.cropRect,
          // `layers` is the STORED (full-photo) basis; `displayLayers` is the
          // derived current-basis position shown on screen.
          layers: layers.map((l) => ({
            id: l.id, type: l.type, x: l.x, y: l.y, scale: l.scale,
            naturalWidth: l.naturalWidth, naturalHeight: l.naturalHeight,
            // Data URLs are megabytes — expose only the kind, not the payload.
            stickerPathKind: typeof l.stickerPath === "string"
              ? (l.stickerPath.startsWith("data:") ? "data" : "path")
              : null,
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
    };
    return () => {
      if (window.__afterframeTest) {
        for (const k of [
          "saveAs", "getPreviewReady", "getSaving", "addTextLayer", "getLayerCount",
          "getTool", "setTool", "getState", "setAspect", "deleteLayer", "moveLayer",
          "selectLayers", "undo", "redo", "setPad", "applyFramePreset", "clearFramePreset",
          "sampleSourcePixel",
        ]) delete window.__afterframeTest[k];
      }
    };
  }, [open, saving, layers, displayLayers, tool, selectedIds, editorState, imageRect, screenOutputRect, screenOutputView, viewTransform, placement, viewportSize]);

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
    setViewTransform(IDENTITY_VIEW_TRANSFORM); // review F4: drop the old fit
    applyLayers(bakedLayers); // history was just wiped; initial-snapshot effect will record it
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
  }, [open, onClose, saving, rotationDeg, flipX, flipY, sourceImage, cropRect, imageRect, outputRect, transformedPreview, tool, selectedIds, layers]);

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
        data-editor-viewport="true"
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
                style={cropCenter ? { transform: `rotate(${freeAngle}deg)`, transformOrigin: `${cropCenter.x}px ${cropCenter.y}px` } : undefined}
              >
                <canvas
                  ref={imageCanvasRef}
                  className="absolute block select-none"
                  style={{
                    left: `${screenImageRect.x}px`,
                    top: `${screenImageRect.y}px`,
                    width: `${screenImageRect.width}px`,
                    height: `${screenImageRect.height}px`,
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
            {tool === "text" && (
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
          </>
        ) : null}


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
                framePresets={frameTool.templates}
                frameThumbs={frameTool.thumbs}
                frameCellAspect={frameTool.cellAspect}
                onApplyPreset={applyFramePreset}
                onClearPreset={clearFramePreset}
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
