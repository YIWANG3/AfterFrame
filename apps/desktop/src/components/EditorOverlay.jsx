import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,

  Redo2,
  RotateCcw,
  RotateCw,
  Cannabis,
  Sparkles,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { fileName, localFileUrl } from "../utils/format";
import { ASPECT_PRESETS, getAspectRatio, resizeCropRect } from "./editor/cropMath";
import AiRepaintPanel from "./editor/AiRepaintPanel";
import BeforeAfterCompare from "./editor/BeforeAfterCompare";
import TextPanel from "./editor/TextPanel";
import TextCanvas from "./editor/TextCanvas";
import StickerPanel from "./editor/StickerPanel";
import { createDefaultLayer, getBgPadding } from "./editor/textState";
import {
  hexToRgba,
  getSourceDimensions,
  releaseCanvasImage,
  buildPreviewSource,
  buildDepthMaskCanvas,
  buildTransformedCanvas,
  deriveEditedFileName,
  replaceFileName,
  inferMimeType,
  canvasToBlob,
} from "./editor/render/canvasHelpers";
import { drawLayersOnCanvas } from "./editor/render/drawLayers";
import StickerRegionOverlay from "./editor/components/StickerRegionOverlay";
import { useStickerImageCache } from "./editor/state/useStickerImageCache";
import { useStickerRegion } from "./editor/state/useStickerRegion";
import { useDepthModel } from "./editor/state/useDepthModel";
import {
  isTextLayer,
  isStickerLayer,
  getTextLayers,
  moveLayerBy,
  removeLayerById,
} from "./editor/layerStack";

const PREVIEW_MAX_EDGE = 2200;
const PANEL_WIDTH = 320;
const PANEL_GAP = 24;
const CANVAS_SIDE_PADDING = 48;
const HANDLE_LENGTH = 24;
const HANDLE_THICKNESS = 3;
const EDGE_HANDLE_LENGTH = 24;
const MIN_IMAGE_ZOOM = 0.72;
const MAX_IMAGE_ZOOM = 20;
const MIN_FREE_ANGLE = -45;
const MAX_FREE_ANGLE = 45;
const BASE_STATE = {
  aspectKey: "free",
  freeAngle: 0,
  quarterTurns: 0,
  flipX: false,
  flipY: false,
  cropRect: null,
  imageZoom: 1,
  imageOffsetX: 0,
  imageOffsetY: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rectEquals(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function cloneState(state) {
  return {
    ...state,
    cropRect: state.cropRect ? { ...state.cropRect } : null,
  };
}

function stateEquals(a, b) {
  return (
    a.aspectKey === b.aspectKey &&
    a.freeAngle === b.freeAngle &&
    a.quarterTurns === b.quarterTurns &&
    a.flipX === b.flipX &&
    a.flipY === b.flipY &&
    a.imageZoom === b.imageZoom &&
    a.imageOffsetX === b.imageOffsetX &&
    a.imageOffsetY === b.imageOffsetY &&
    rectEquals(a.cropRect, b.cropRect)
  );
}

function FooterButton({ icon: Icon, label, onClick, disabled = false, primary = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex h-8 items-center rounded-md text-[11px] font-medium transition-colors disabled:cursor-default disabled:opacity-35",
        label ? "gap-1.5 px-3" : "w-8 justify-center",
        primary
          ? "bg-[rgb(var(--accent-color))] text-black hover:brightness-110"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label ? <span>{label}</span> : null}
    </button>
  );
}

function ToolTab({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]"
          : "text-muted2 hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function getStageBounds(viewportSize) {
  return {
    width: Math.max(200, viewportSize.width - PANEL_WIDTH - PANEL_GAP - CANVAS_SIDE_PADDING * 2),
    height: Math.max(200, viewportSize.height - 140),
  };
}

function getBasePlacement(viewportSize, transformedPreview) {
  if (!transformedPreview) return null;
  const stage = getStageBounds(viewportSize);
  const fitScale = Math.min(
    stage.width / transformedPreview.width,
    stage.height / transformedPreview.height,
  ) * 0.94;
  const centerX = CANVAS_SIDE_PADDING + stage.width / 2 - 26;
  const centerY = viewportSize.height / 2 - 30;
  return { fitScale, centerX, centerY };
}

function getMinZoomForCrop(cropRect, transformedPreview, placement) {
  if (!cropRect || !transformedPreview || !placement) return 0;
  return Math.max(
    cropRect.width / (transformedPreview.width * placement.fitScale),
    cropRect.height / (transformedPreview.height * placement.fitScale),
  );
}

function getImageRect(state, transformedPreview, placement) {
  if (!state || !transformedPreview || !placement) return null;
  const zoom = state.imageZoom;
  const width = transformedPreview.width * placement.fitScale * zoom;
  const height = transformedPreview.height * placement.fitScale * zoom;
  return {
    x: placement.centerX - width / 2 + state.imageOffsetX,
    y: placement.centerY - height / 2 + state.imageOffsetY,
    width,
    height,
  };
}

function clampImagePlacement(state, transformedPreview, placement) {
  if (!state.cropRect || !transformedPreview || !placement) return state;
  const minZoom = getMinZoomForCrop(state.cropRect, transformedPreview, placement);
  const imageZoom = clamp(state.imageZoom, minZoom, MAX_IMAGE_ZOOM);
  const width = transformedPreview.width * placement.fitScale * imageZoom;
  const height = transformedPreview.height * placement.fitScale * imageZoom;
  const minOffsetX = state.cropRect.x + state.cropRect.width - (placement.centerX + width / 2);
  const maxOffsetX = state.cropRect.x - (placement.centerX - width / 2);
  const minOffsetY = state.cropRect.y + state.cropRect.height - (placement.centerY + height / 2);
  const maxOffsetY = state.cropRect.y - (placement.centerY - height / 2);
  return {
    ...state,
    imageZoom,
    imageOffsetX: clamp(state.imageOffsetX, minOffsetX, maxOffsetX),
    imageOffsetY: clamp(state.imageOffsetY, minOffsetY, maxOffsetY),
  };
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

function createCenteredCrop(maxWidth, maxHeight, aspect, cx, cy) {
  let width = maxWidth;
  let height = maxHeight;
  if (aspect) {
    height = width / aspect;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * aspect;
    }
  }
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  };
}

function symmetricResize(cropRect, handle, point, aspect) {
  if (!cropRect) return cropRect;
  const cx = cropRect.x + cropRect.width / 2;
  const cy = cropRect.y + cropRect.height / 2;
  let halfW = cropRect.width / 2;
  let halfH = cropRect.height / 2;

  if (handle.includes("e") || handle.includes("w")) {
    halfW = Math.max(MIN_CROP_SIZE / 2, Math.abs(point.x - cx));
  }
  if (handle.includes("s") || handle.includes("n")) {
    halfH = Math.max(MIN_CROP_SIZE / 2, Math.abs(point.y - cy));
  }
  if (handle === "n" || handle === "s") halfW = cropRect.width / 2;
  if (handle === "e" || handle === "w") halfH = cropRect.height / 2;

  if (aspect) {
    if (handle === "n" || handle === "s") {
      halfW = halfH * aspect;
    } else if (handle === "e" || handle === "w") {
      halfH = halfW / aspect;
    } else {
      const candidateH = halfW / aspect;
      if (candidateH > halfH) {
        halfW = halfH * aspect;
      } else {
        halfH = candidateH;
      }
    }
  }

  halfW = Math.max(MIN_CROP_SIZE / 2, halfW);
  halfH = Math.max(MIN_CROP_SIZE / 2, halfH);

  return {
    x: cx - halfW,
    y: cy - halfH,
    width: halfW * 2,
    height: halfH * 2,
  };
}

const MIN_CROP_SIZE = 48;

const HANDLE_SPECS = [
  { key: "nw", type: "corner", mode: "resize", style: { left: -1, top: -1 }, cursor: "nwse-resize" },
  { key: "ne", type: "corner", mode: "resize", style: { right: -1, top: -1, transform: "scaleX(-1)" }, cursor: "nesw-resize" },
  { key: "sw", type: "corner", mode: "resize", style: { left: -1, bottom: -1, transform: "scaleY(-1)" }, cursor: "nesw-resize" },
  { key: "se", type: "corner", mode: "resize", style: { right: -1, bottom: -1, transform: "scale(-1,-1)" }, cursor: "nwse-resize" },
  { key: "n", type: "edge-x", mode: "resize", style: { left: "50%", top: -1, transform: "translateX(-50%)" }, cursor: "ns-resize" },
  { key: "s", type: "edge-x", mode: "resize", style: { left: "50%", bottom: -1, transform: "translateX(-50%) scaleY(-1)" }, cursor: "ns-resize" },
  { key: "w", type: "edge-y", mode: "resize", style: { left: -1, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  { key: "e", type: "edge-y", mode: "resize", style: { right: -1, top: "50%", transform: "translateY(-50%) scaleX(-1)" }, cursor: "ew-resize" },
];

function HandleVisual({ type }) {
  if (type === "corner") {
    return (
      <>
        <div className="absolute left-0 top-0 bg-white" style={{ width: `${HANDLE_LENGTH}px`, height: `${HANDLE_THICKNESS}px` }} />
        <div className="absolute left-0 top-0 bg-white" style={{ width: `${HANDLE_THICKNESS}px`, height: `${HANDLE_LENGTH}px` }} />
      </>
    );
  }
  if (type === "edge-x") {
    return <div className="absolute left-1/2 top-0 -translate-x-1/2 bg-white" style={{ width: `${EDGE_HANDLE_LENGTH}px`, height: `${HANDLE_THICKNESS}px` }} />;
  }
  return <div className="absolute left-0 top-1/2 -translate-y-1/2 bg-white" style={{ width: `${HANDLE_THICKNESS}px`, height: `${EDGE_HANDLE_LENGTH}px` }} />;
}

function getAspectPreviewBox(aspectKey) {
  const aspect = getAspectRatio(aspectKey, 1);
  if (!aspect) {
    return {
      width: 14,
      height: 10,
      dashed: true,
    };
  }

  const max = 14;
  if (aspect >= 1) {
    return {
      width: max,
      height: Math.max(6, Math.round(max / aspect)),
      dashed: false,
    };
  }
  return {
    width: Math.max(6, Math.round(max * aspect)),
    height: max,
    dashed: false,
  };
}

function AspectButton({ preset, active, onClick }) {
  const preview = getAspectPreviewBox(preset.key);

  return (
    <button
      type="button"
      className={[
        "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] transition-colors",
        active ? "bg-selected text-accent" : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="flex h-4 w-4 items-center justify-center shrink-0">
        <span
          className="block border border-current opacity-70"
          style={{
            width: `${preview.width}px`,
            height: `${preview.height}px`,
            borderStyle: preview.dashed ? "dashed" : "solid",
            borderRadius: "3px",
          }}
        />
      </span>
      <span>{preset.label}</span>
    </button>
  );
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
  const viewportRef = useRef(null);
  const imageCanvasRef = useRef(null);
  const depthOverlayCanvasRef = useRef(null);
  const sourceImageRef = useRef(null);
  const nativeSaveSourcePathRef = useRef(null);
  const pointerStateRef = useRef(null);
  const editorStateRef = useRef(cloneState(BASE_STATE));
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const baseSnapshotRef = useRef(null);
  const angleDragStartRef = useRef(null);
  const quickSavePathRef = useRef(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [loadState, setLoadState] = useState("idle");
  const [pointerPoint, setPointerPoint] = useState(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [sourceImage, setSourceImage] = useState(null);
  const [previewSource, setPreviewSource] = useState(null);
  const [tool, setTool] = useState("crop");
  const [editorState, setEditorState] = useState(cloneState(BASE_STATE));
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeInteraction, setActiveInteraction] = useState(null);
  const [compareState, setCompareState] = useState(null); // { afterPath, layout: "side"|"stack" }
  const [layers, setLayers] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const layerHistoryRef = useRef([[]]);
  const layerHistoryIndexRef = useRef(0);
  const textClipboardRef = useRef(null);
  // Scene-level depth: one Depth Anything V2 inference per source image,
  // cached as both an Image (for visualization) and a Canvas (for pixel reads).
  const [depthGenerating, setDepthGenerating] = useState(false);
  const [depthError, setDepthError] = useState(null);
  const [depthSourcePath, setDepthSourcePath] = useState(null); // path of the depth PNG on disk
  const depthFieldImageRef = useRef(null);   // HTMLImageElement
  const depthFieldCanvasRef = useRef(null);  // OffscreenCanvas-style canvas at 518x392
  const [depthFieldVersion, setDepthFieldVersion] = useState(0); // bumps when depth changes
  const [depthFeather, setDepthFeather] = useState(0.08);        // global, 0..0.5
  const [depthMapVisible, setDepthMapVisible] = useState(false); // debug overlay toggle
  const stickerImageCache = useStickerImageCache(layers);
  const sticker = useStickerRegion(item?.asset_id);

  const { depthModel, pickDepthModel: handlePickDepthModel, resetDepthModel: handleResetDepthModel } =
    useDepthModel({
      sourcePath: item?.export_path || item?.export_preview_path || item?.raw_preview_path || null,
      onComputeDepth: (opts) => handleComputeDepth(opts),
      onError: setDepthError,
    });

  const sourcePath = item?.export_path || item?.export_preview_path || item?.raw_preview_path || null;
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
    ? { title: "Crop", badge: null }
    : tool === "ai"
      ? { title: "AI Repaint", badge: null }
      : tool === "text"
        ? { title: "Text", badge: null }
        : tool === "sticker"
          ? { title: "Sticker", badge: null }
          : { title: "", badge: null };

  function syncHistory(nextHistory, nextIndex) {
    historyRef.current = nextHistory;
    historyIndexRef.current = nextIndex;
    setHistory(nextHistory);
    setHistoryIndex(nextIndex);
  }

  function applyState(nextState) {
    const snapshot = cloneState(nextState);
    editorStateRef.current = snapshot;
    setEditorState(snapshot);
    return snapshot;
  }

  function recordState(nextState) {
    const snapshot = applyState(nextState);
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    nextHistory.push(snapshot);
    syncHistory(nextHistory, nextHistory.length - 1);
    return snapshot;
  }

  function commitLayers(nextLayers) {
    const snap = nextLayers.map((l) => ({ ...l }));
    layerHistoryRef.current = layerHistoryRef.current.slice(0, layerHistoryIndexRef.current + 1);
    layerHistoryRef.current.push(snap);
    layerHistoryIndexRef.current = layerHistoryRef.current.length - 1;
    setLayers(snap);
  }
  function layerUndo() {
    if (layerHistoryIndexRef.current <= 0) return;
    layerHistoryIndexRef.current--;
    setLayers(layerHistoryRef.current[layerHistoryIndexRef.current]);
  }
  function layerRedo() {
    if (layerHistoryIndexRef.current >= layerHistoryRef.current.length - 1) return;
    layerHistoryIndexRef.current++;
    setLayers(layerHistoryRef.current[layerHistoryIndexRef.current]);
  }
  function layerReset() {
    commitLayers([]);
    setSelectedIds(new Set());
    clearSceneDepth();
  }
  function layerResetHard() {
    setLayers([]);
    setSelectedIds(new Set());
    layerHistoryRef.current = [[]];
    layerHistoryIndexRef.current = 0;
    clearSceneDepth();
  }

  function handleMoveLayer(id, direction) {
    commitLayers(moveLayerBy(layers, id, direction));
  }

  function handleDeleteLayer(id) {
    commitLayers(removeLayerById(layers, id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function clearSceneDepth() {
    depthFieldImageRef.current = null;
    depthFieldCanvasRef.current = null;
    setDepthSourcePath(null);
    setDepthFieldVersion((v) => v + 1);
  }

  async function loadDepthFromPath(fieldPath) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to load depth field"));
      img.src = localFileUrl(fieldPath);
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    depthFieldImageRef.current = img;
    depthFieldCanvasRef.current = canvas;
    setDepthSourcePath(fieldPath);
    setDepthFieldVersion((v) => v + 1);
  }

  async function handleComputeDepth({ force = false } = {}) {
    if (!sourcePath) {
      setDepthError("No source image.");
      return;
    }
    if (!window.mediaWorkspace?.computeDepth) {
      setDepthError("Depth API unavailable.");
      return;
    }
    setDepthGenerating(true);
    setDepthError(null);
    try {
      const result = await window.mediaWorkspace.computeDepth({ sourcePath, force });
      if (!result?.outputPath) throw new Error("Empty result");
      await loadDepthFromPath(result.outputPath);
    } catch (err) {
      setDepthError(err instanceof Error ? err.message : String(err));
    } finally {
      setDepthGenerating(false);
    }
  }

  function handleClearDepth() {
    clearSceneDepth();
    setDepthError(null);
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

    drawTextLayersOnCanvas(ctx, sw, sh, renderable);

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

  useEffect(() => {
    if (!open || !sourcePath) return undefined;
    let active = true;
    setTool("crop");
    setMessage("");
    setCompareState(null);
    setLoadState("loading");
    setSourceImage(null);
    setPreviewSource(null);
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

    // Release previous source image canvas memory
    const prevSource = sourceImageRef.current;
    releaseCanvasImage(prevSource);
    sourceImageRef.current = null;

    async function load() {
      try {
        const url = localFileUrl(sourcePath);
        let image;
        let alreadyDownsampled = false;

        try {
          image = new Image();
          image.decoding = "async";
          image.src = url;
          await image.decode();
        } catch {
          // Image.decode() failed — likely too large for full decode.
          // Fall back to createImageBitmap which can decode+resize in one pass.
          image = null;
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();

          let bitmap;
          try {
            bitmap = await createImageBitmap(blob);
          } catch {
            // Full-size bitmap also fails — force a capped decode
            bitmap = await createImageBitmap(blob, {
              resizeWidth: PREVIEW_MAX_EDGE,
              resizeQuality: "high",
            });
          }

          // Downscale if still larger than preview max
          const maxEdge = Math.max(bitmap.width, bitmap.height);
          if (maxEdge > PREVIEW_MAX_EDGE) {
            const scale = PREVIEW_MAX_EDGE / maxEdge;
            const small = await createImageBitmap(blob, {
              resizeWidth: Math.round(bitmap.width * scale),
              resizeHeight: Math.round(bitmap.height * scale),
              resizeQuality: "high",
            });
            bitmap.close();
            bitmap = small;
          }

          // Bail early if component unmounted during async work
          if (!active) {
            bitmap.close();
            return;
          }

          // Transfer bitmap → canvas (canvas is a valid CanvasImageSource everywhere)
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.naturalWidth = bitmap.width;
          canvas.naturalHeight = bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          image = canvas;
          alreadyDownsampled = true;
        }

        if (!active) return;
        sourceImageRef.current = image;
        setSourceImage(image);
        setPreviewSource(alreadyDownsampled ? image : buildPreviewSource(image));
        setLoadState("ready");
      } catch (error) {
        if (!active) return;
        setLoadState("error");
        setMessage(error instanceof Error ? error.message : "The source image cannot be decoded.");
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [open, sourcePath]);

  // Release canvas memory when editor closes
  useEffect(() => () => {
    const src = sourceImageRef.current;
    releaseCanvasImage(src);
    sourceImageRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return undefined;
    const element = viewportRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewportSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const transformedPreview = useMemo(() => {
    if (!previewSource) return null;
    return buildTransformedCanvas(previewSource, previewSource.width, previewSource.height, discreteRotationDeg, flipX, flipY);
  }, [previewSource, discreteRotationDeg, flipX, flipY]);

  const placement = useMemo(
    () => getBasePlacement(viewportSize, transformedPreview),
    [viewportSize, transformedPreview],
  );

  useEffect(() => {
    if (!transformedPreview || !placement || baseSnapshotRef.current) return;
    const initial = createInitialSnapshot(viewportSize, transformedPreview);
    baseSnapshotRef.current = cloneState(initial);
    recordState(initial);
  }, [placement, transformedPreview, viewportSize]);

  const imageRect = useMemo(
    () => getImageRect(editorState, transformedPreview, placement),
    [editorState, transformedPreview, placement],
  );
  const cropCenter = cropRect
    ? {
        x: cropRect.x + cropRect.width / 2,
        y: cropRect.y + cropRect.height / 2,
      }
    : null;

  function pointFromClient(clientX, clientY) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function commitAspect(nextAspectKey) {
    if (!transformedPreview || !imageRect || !editorStateRef.current.cropRect) return;
    const aspect = getAspectRatio(nextAspectKey, imageRect.width / imageRect.height);
    const cx = editorStateRef.current.cropRect.x + editorStateRef.current.cropRect.width / 2;
    const cy = editorStateRef.current.cropRect.y + editorStateRef.current.cropRect.height / 2;
    const nextCrop = createCenteredCrop(imageRect.width, imageRect.height, aspect, cx, cy);
    const next = clampImagePlacement(
      {
        ...editorStateRef.current,
        aspectKey: nextAspectKey,
        cropRect: nextCrop,
      },
      transformedPreview,
      placement,
    );
    recordState(next);
  }

  function commitTransform(patch) {
    if (!previewSource) {
      console.warn("[Editor] commitTransform: previewSource is null, aborting");
      return;
    }
    console.log("[Editor] commitTransform called with patch:", patch);
    const candidate = {
      ...editorStateRef.current,
      ...patch,
      imageZoom: 1,
      imageOffsetX: 0,
      imageOffsetY: 0,
    };
    const nextPreview = buildTransformedCanvas(
      previewSource,
      previewSource.width,
      previewSource.height,
      candidate.quarterTurns * 90 + candidate.freeAngle,
      candidate.flipX,
      candidate.flipY,
    );
    const nextPlacement = getBasePlacement(viewportSize, nextPreview);
    const nextImageRect = getImageRect(candidate, nextPreview, nextPlacement);
    const aspect = getAspectRatio(candidate.aspectKey, nextImageRect.width / nextImageRect.height);
    const nextCrop = createCenteredCrop(nextImageRect.width, nextImageRect.height, aspect, nextPlacement.centerX, nextPlacement.centerY);
    console.log("[Editor] commitTransform result - nextImageRect:", nextImageRect, "quarterTurns:", candidate.quarterTurns);
    recordState({
      ...candidate,
      cropRect: nextCrop,
    });
  }

  function beginCropResize(handle, event) {
    event.preventDefault();
    event.stopPropagation();
    if (!cropRect) return;
    pointerStateRef.current = {
      mode: "crop-resize",
      handle,
      pointerId: event.pointerId,
      startState: cloneState(editorStateRef.current),
    };
    setActiveInteraction("crop-resize");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginRotate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!cropRect) return;
    const point = pointFromClient(event.clientX, event.clientY);
    const center = {
      x: cropRect.x + cropRect.width / 2,
      y: cropRect.y + cropRect.height / 2,
    };
    pointerStateRef.current = {
      mode: "rotate",
      pointerId: event.pointerId,
      startState: cloneState(editorStateRef.current),
      startAngle: Math.atan2(point.y - center.y, point.x - center.x),
    };
    setActiveInteraction("rotate");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginImagePan(event) {
    event.preventDefault();
    if (!imageRect || !cropRect) return;
    const point = pointFromClient(event.clientX, event.clientY);
    pointerStateRef.current = {
      mode: "image-pan",
      pointerId: event.pointerId,
      startPoint: point,
      startState: cloneState(editorStateRef.current),
    };
    setActiveInteraction("image-pan");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const active = pointerStateRef.current;
    if (!active || active.pointerId !== event.pointerId || !transformedPreview || !placement) return;
    const point = pointFromClient(event.clientX, event.clientY);


    if (active.mode === "image-pan") {
      const next = clampImagePlacement(
        {
          ...active.startState,
          imageOffsetX: active.startState.imageOffsetX + (point.x - active.startPoint.x),
          imageOffsetY: active.startState.imageOffsetY + (point.y - active.startPoint.y),
        },
        transformedPreview,
        placement,
      );
      applyState(next);
      return;
    }

    if (active.mode === "rotate") {
      const center = {
        x: active.startState.cropRect.x + active.startState.cropRect.width / 2,
        y: active.startState.cropRect.y + active.startState.cropRect.height / 2,
      };
      const currentAngle = Math.atan2(point.y - center.y, point.x - center.x);
      const deltaDegrees = ((currentAngle - active.startAngle) * 180) / Math.PI;
      applyState({
        ...active.startState,
        freeAngle: clamp(active.startState.freeAngle + deltaDegrees, MIN_FREE_ANGLE, MAX_FREE_ANGLE),
      });
      return;
    }

    const nextCrop = symmetricResize(
      active.startState.cropRect,
      active.handle,
      point,
      getAspectRatio(active.startState.aspectKey, active.startState.cropRect.width / active.startState.cropRect.height),
    );

    const w = nextCrop.width;
    const h = nextCrop.height;
    const w0 = active.startState.cropRect.width;
    const h0 = active.startState.cropRect.height;
    
    // Check if the new crop forces the image to zoom in
    const minZ = getMinZoomForCrop(nextCrop, transformedPreview, placement);
    const nextZ = clamp(Math.max(active.startState.imageZoom, minZ), MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
    const factor = nextZ / active.startState.imageZoom;

    // Calculate shift to keep the anchored corner/edge glued to the image pixel
    let dx = 0;
    let dy = 0;
    if (active.handle.includes("w")) dx = (w - factor * w0) / 2;
    if (active.handle.includes("e")) dx = (factor * w0 - w) / 2;
    if (active.handle.includes("n")) dy = (h - factor * h0) / 2;
    if (active.handle.includes("s")) dy = (factor * h0 - h) / 2;

    const next = clampImagePlacement(
      {
        ...active.startState,
        imageZoom: nextZ,
        cropRect: nextCrop,
        imageOffsetX: active.startState.imageOffsetX * factor + dx,
        imageOffsetY: active.startState.imageOffsetY * factor + dy,
      },
      transformedPreview,
      placement,
    );
    applyState(next);
  }

  function handlePointerEnd(event) {
    const active = pointerStateRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    pointerStateRef.current = null;
    setActiveInteraction(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (JSON.stringify(active.startState) !== JSON.stringify(editorStateRef.current)) {
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(cloneState(editorStateRef.current));
      syncHistory(nextHistory, nextHistory.length - 1);
    } else {
      applyState(active.startState);
    }
  }

  const handleWheelRef = useRef(null);
  handleWheelRef.current = { transformedPreview, placement };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      console.warn("[Editor] setup wheel: viewportRef is null!");
      return undefined;
    }
    console.log("[Editor] setup wheel attached to viewport", el);
    function onWheel(event) {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-editor-wheel-scope='panel'], [data-editor-wheel-scope='toolbar']")
      ) {
        return;
      }
      console.log("[Editor] onWheel RAW - deltaX:", event.deltaX, "deltaY:", event.deltaY, "ctrl:", event.ctrlKey);
      const { transformedPreview: tp, placement: pl } = handleWheelRef.current || {};
      if (!tp || !pl) {
        console.log("[Editor] onWheel aborted: missing tp or pl");
        return;
      }
      event.preventDefault();
      const current = editorStateRef.current;
      if (!current.cropRect) {
        console.log("[Editor] onWheel aborted: missing cropRect");
        return;
      }

      const isZoom = event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX);

      if (isZoom) {
        // --- WORKSPACE ZOOM (Anchored to crop box center) ---
        const factor = event.deltaY > 0 ? 0.94 : 1.06;
        const proposedCropW = current.cropRect.width * factor;
        const proposedCropH = current.cropRect.height * factor;
        if (proposedCropW < MIN_CROP_SIZE || proposedCropH < MIN_CROP_SIZE) return;

        const pt = {
          x: current.cropRect.x + current.cropRect.width / 2,
          y: current.cropRect.y + current.cropRect.height / 2,
        };
        
        let nextZoom = current.imageZoom * factor;
        if (nextZoom > MAX_IMAGE_ZOOM) {
          const adjFactor = MAX_IMAGE_ZOOM / current.imageZoom;
          nextZoom = MAX_IMAGE_ZOOM;
          if (adjFactor <= 1) return;
        }

        const nextCrop = {
          x: pt.x + (current.cropRect.x - pt.x) * factor,
          y: pt.y + (current.cropRect.y - pt.y) * factor,
          width: proposedCropW,
          height: proposedCropH,
        };

        const oldCenterX = pl.centerX + current.imageOffsetX;
        const oldCenterY = pl.centerY + current.imageOffsetY;
        const newCenterX = pt.x + (oldCenterX - pt.x) * factor;
        const newCenterY = pt.y + (oldCenterY - pt.y) * factor;

        const next = clampImagePlacement(
          {
            ...current,
            imageZoom: nextZoom,
            cropRect: nextCrop,
            imageOffsetX: newCenterX - pl.centerX,
            imageOffsetY: newCenterY - pl.centerY,
          },
          tp,
          pl,
        );
        recordState(next);
      } else {
        // --- IMAGE PAN (Trackpad Scroll) ---
        const dx = -event.deltaX;
        const dy = -event.deltaY;

        const next = clampImagePlacement(
          {
            ...current,
            imageOffsetX: current.imageOffsetX + dx,
            imageOffsetY: current.imageOffsetY + dy,
          },
          tp,
          pl,
        );
        recordState(next);
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  useEffect(() => {
    if (!transformedPreview || !placement || !editorStateRef.current.cropRect) return;
    const clamped = clampImagePlacement(editorStateRef.current, transformedPreview, placement);
    if (!stateEquals(clamped, editorStateRef.current)) {
      applyState(clamped);
    }
  }, [transformedPreview, placement]);

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


  function handleUndo() {
    if (historyIndexRef.current <= 0) return;
    const nextIndex = historyIndexRef.current - 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    applyState(historyRef.current[nextIndex]);
  }

  function handleRedo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    const nextIndex = historyIndexRef.current + 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    applyState(historyRef.current[nextIndex]);
  }

  function handleReset() {
    if (!baseSnapshotRef.current) return;
    recordState(baseSnapshotRef.current);
    setMessage("");
  }

  function beginAngleDrag() {
    angleDragStartRef.current = cloneState(editorStateRef.current);
  }

  function updateAngle(nextAngle) {
    console.log("[Editor] updateAngle called:", nextAngle, "cropRect:", editorStateRef.current.cropRect);
    applyState({
      ...editorStateRef.current,
      freeAngle: clamp(nextAngle, MIN_FREE_ANGLE, MAX_FREE_ANGLE),
    });
  }

  function endAngleDrag() {
    if (!angleDragStartRef.current) return;
    if (!stateEquals(angleDragStartRef.current, editorStateRef.current)) {
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(cloneState(editorStateRef.current));
      syncHistory(nextHistory, nextHistory.length - 1);
    }
    angleDragStartRef.current = null;
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

  async function executeSave(savePath) {
    setSaving(true);
    setMessage("");
    try {
      const normalized = getNormalizedCrop();

      // Try native sharp processing (full resolution) — skip if any overlay layers exist
      if (window.mediaWorkspace?.processAndSave && nativeSaveSourcePathRef.current && layers.length === 0) {
        try {
          await window.mediaWorkspace.processAndSave({
            sourcePath: nativeSaveSourcePathRef.current,
            savePath,
            quarterTurns,
            freeAngle,
            flipX,
            flipY,
            crop: normalized,
            quality: 92,
          });

          // Auto-import into catalog. Editor stays open; toast surfaces the
          // saved path + Show in Finder, then auto-dismisses after 20s.
          await window.mediaWorkspace.quickRegister?.(savePath, sourcePath);
          onSaveComplete?.(savePath);
          return;
        } catch (nativeError) {
          console.error("[Editor] Native sharp save failed, falling back to canvas export:", nativeError);
          console.error("[Editor] sourcePath was:", sourcePath);
        }
      }

      // Fallback: canvas-based processing (limited to sourceImage resolution)
      if (!sourceImage || !transformedPreview) {
        throw new Error("Image not loaded");
      }
      const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
      const transformedFull = buildTransformedCanvas(
        sourceImage,
        sourceWidth,
        sourceHeight,
        rotationDeg,
        flipX,
        flipY,
      );

      const exportRect = normalized
        ? {
            x: Math.round(normalized.x * transformedFull.width),
            y: Math.round(normalized.y * transformedFull.height),
            width: Math.max(1, Math.round(normalized.width * transformedFull.width)),
            height: Math.max(1, Math.round(normalized.height * transformedFull.height)),
          }
        : { x: 0, y: 0, width: transformedFull.width, height: transformedFull.height };

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = exportRect.width;
      outputCanvas.height = exportRect.height;
      const context = outputCanvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        transformedFull,
        exportRect.x,
        exportRect.y,
        exportRect.width,
        exportRect.height,
        0,
        0,
        exportRect.width,
        exportRect.height,
      );

      // Walk text layers in stack order. Each one is rendered to a temp canvas,
      // optionally masked by the scene depth field (per-text zPosition), then
      // composited onto the final output.
      const fullW = transformedFull.width;
      const fullH = transformedFull.height;
      const sceneDepth = depthFieldCanvasRef.current;
      for (const layer of layers) {
        if (!isTextLayer(layer) && !isStickerLayer(layer)) continue;
        const absX = layer.x * fullW - exportRect.x;
        const absY = layer.y * fullH - exportRect.y;
        // Sticker scale is fraction of source image width — when we crop the
        // export to a sub-rect, rescale so the visible sticker stays the same
        // physical size on disk.
        const scaleAdjust = isStickerLayer(layer)
          ? { scale: (layer.scale ?? 0.4) * (fullW / exportRect.width) }
          : null;
        const mappedLayer = {
          ...layer,
          x: absX / exportRect.width,
          y: absY / exportRect.height,
          ...(scaleAdjust || {}),
        };
        const useDepth = sceneDepth && layer.zPosition != null && layer.zPosition < 1;
        if (!useDepth) {
          drawTextLayersOnCanvas(context, exportRect.width, exportRect.height, [mappedLayer]);
          continue;
        }
        // Render text on a temp canvas, then mask with depth
        const tmp = document.createElement("canvas");
        tmp.width = exportRect.width;
        tmp.height = exportRect.height;
        drawTextLayersOnCanvas(tmp.getContext("2d"), exportRect.width, exportRect.height, [mappedLayer]);
        const mask = buildDepthMaskCanvas(sceneDepth, exportRect.width, exportRect.height, layer.zPosition, depthFeather);
        const t = tmp.getContext("2d");
        t.globalCompositeOperation = "destination-in";
        t.drawImage(mask, 0, 0);
        context.drawImage(tmp, 0, 0);
        releaseCanvasImage(mask);
        releaseCanvasImage(tmp);
      }

      const blob = await canvasToBlob(outputCanvas, inferMimeType(savePath));
      await window.mediaWorkspace?.saveImage?.(savePath, await blob.arrayBuffer(), sourcePath);
      releaseCanvasImage(transformedFull);
      releaseCanvasImage(outputCanvas);

      // Auto-import into catalog. Stay open after save; toast surfaces path.
      await window.mediaWorkspace.quickRegister?.(savePath, sourcePath);
      onSaveComplete?.(savePath);
    } catch (error) {
      pushToast?.({
        title: "Save failed",
        message: error instanceof Error ? error.message : "Failed to save image",
        ttl: 20_000,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    if (!cropRect || !imageRect || saving) return;
    const defaultPath = replaceFileName(sourcePath, deriveEditedFileName(sourcePath));
    const savePath = await window.mediaWorkspace?.pickSavePath?.({
      defaultPath,
      filters: [
        { name: "JPEG", extensions: ["jpg", "jpeg"] },
        { name: "PNG", extensions: ["png"] },
        { name: "WebP", extensions: ["webp"] },
      ],
    });
    if (!savePath) return;
    await executeSave(savePath);
  }

  async function handleQuickSave() {
    if (!cropRect || !imageRect || saving) return;
    if (!quickSavePathRef.current) {
      quickSavePathRef.current = replaceFileName(sourcePath, deriveEditedFileName(sourcePath));
    }
    await executeSave(quickSavePathRef.current);
  }

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
        const copied = layers.filter((l) => isTextLayer(l) && selectedIds.has(l.id)).map((l) => ({ ...l }));
        if (copied.length > 0) textClipboardRef.current = copied;
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v" && tool === "text" && textClipboardRef.current?.length > 0) {
        event.preventDefault();
        const pasted = textClipboardRef.current.map((l) => {
          const { id, ...rest } = l;
          return createDefaultLayer({ ...rest, x: l.x + 0.02, y: l.y + 0.02 });
        });
        const currentLayers = layerHistoryRef.current[layerHistoryIndexRef.current] || [];
        commitLayers([...currentLayers, ...pasted]);
        setSelectedIds(new Set(pasted.map((p) => p.id)));
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && tool === "text" && selectedIds.size > 0) {
        event.preventDefault();
        commitLayers(layers.filter((l) => !selectedIds.has(l.id)));
        setSelectedIds(new Set());
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

  return (
    <div className="fixed inset-0 z-[10100] flex flex-col bg-app text-text">
      <div className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/60 bg-chrome px-4">
        <div className="absolute left-3 flex items-center gap-2 text-[12px]">
          <span className="max-w-[40vw] truncate text-muted2">{sourceLabel}</span>
          {!stateEquals(editorState, baseSnapshotRef.current || BASE_STATE) ? (
            <span className="text-[11px] text-muted2/60">Edited</span>
          ) : null}
          {(() => {
            if (!sourceImage || !imageRect) return null;
            const radians = (rotationDeg * Math.PI) / 180;
            const absCos = Math.abs(Math.cos(radians));
            const absSin = Math.abs(Math.sin(radians));
            const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
            const nativeWidth = sourceWidth * absCos + sourceHeight * absSin;
            const scale = nativeWidth / imageRect.width;
            const dims = `${sourceWidth} × ${sourceHeight}`;
            if (!showCropUi || !cropRect) {
              return <span className="text-[11px] text-muted2/60">· {dims}</span>;
            }
            const cropW = Math.round(cropRect.width * scale);
            const cropH = Math.round(cropRect.height * scale);
            return <span className="text-[11px] text-muted2/60">· {dims} · Crop {cropW} × {cropH}</span>;
          })()}
        </div>
        <div className="absolute right-3 flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[rgba(var(--accent-color),0.10)] px-3 text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgba(var(--accent-color),0.18)] disabled:opacity-60"
            onClick={() => void handleExport()}
            disabled={saving || loadState !== "ready"}
            title="Save image"
          >
            <Download className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted2 transition-colors hover:bg-hover hover:text-text"
            onClick={onClose}
            title="Close editor (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-app"
        style={{ cursor: spacePressed ? "grab" : activeInteraction === "rotate" ? "crosshair" : activeInteraction === "image-pan" ? "grabbing" : "default" }}
        onPointerDown={spacePressed ? beginImagePan : undefined}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {loadState === "loading" ? <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">Loading editor…</div> : null}
        {loadState === "error" ? <div className="absolute inset-0 grid place-items-center text-[13px] text-muted">{message || "Failed to load image"}</div> : null}

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

            {/* Non-rotating crop overlay — stays axis-aligned, z-10 above rotated image */}
            {showCropUi && cropRect ? (
              <div className="pointer-events-none absolute inset-0" style={{ zIndex: 10 }}>
                <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: `${Math.max(0, cropRect.y)}px`, backgroundColor: "var(--crop-scrim)" }} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: `${Math.max(0, viewportSize.height - cropRect.y - cropRect.height)}px`, backgroundColor: "var(--crop-scrim)" }} />
                <div className="pointer-events-none absolute" style={{ left: 0, top: `${Math.max(0, cropRect.y)}px`, width: `${Math.max(0, cropRect.x)}px`, height: `${Math.min(cropRect.height, viewportSize.height - Math.max(0, cropRect.y))}px`, backgroundColor: "var(--crop-scrim)" }} />
                <div className="pointer-events-none absolute" style={{ right: 0, top: `${Math.max(0, cropRect.y)}px`, width: `${Math.max(0, viewportSize.width - cropRect.x - cropRect.width)}px`, height: `${Math.min(cropRect.height, viewportSize.height - Math.max(0, cropRect.y))}px`, backgroundColor: "var(--crop-scrim)" }} />

                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: `${cropRect.x}px`,
                    top: `${cropRect.y}px`,
                    width: `${cropRect.width}px`,
                    height: `${cropRect.height}px`,
                    border: "1.5px solid rgba(255,255,255,0.9)",
                  }}
                >
                  <div className="pointer-events-none absolute inset-y-0" style={{ left: "33.333%", width: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
                  <div className="pointer-events-none absolute inset-y-0" style={{ left: "66.666%", width: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
                  <div className="pointer-events-none absolute inset-x-0" style={{ top: "33.333%", height: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
                  <div className="pointer-events-none absolute inset-x-0" style={{ top: "66.666%", height: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />

                  {HANDLE_SPECS.map((handle) => (
                    <div
                      key={handle.key}
                      className="pointer-events-auto absolute"
                      style={{
                        ...handle.style,
                        zIndex: 20,
                        width: `${HANDLE_LENGTH}px`,
                        height: `${HANDLE_LENGTH}px`,
                        cursor: handle.cursor,
                      }}
                      onPointerDown={(event) => beginCropResize(handle.key, event)}
                    >
                      <HandleVisual type={handle.type} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="pointer-events-none absolute right-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-3">
          <div
            className="pointer-events-auto overflow-hidden rounded-xl border border-border/60 bg-chrome/95 shadow-overlay backdrop-blur-xl"
            style={{ width: `${PANEL_WIDTH}px` }}
            data-editor-wheel-scope="panel"
          >
            <div className="flex h-6 items-center justify-between border-b border-border/60 bg-panel2 px-3">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--accent-color)/0.72)]">{panelMeta.title}</div>
              {panelMeta.badge ? (
                <div className="rounded-full bg-[rgb(var(--accent-color)/0.10)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--accent-color))]">
                  {panelMeta.badge}
                </div>
              ) : null}
            </div>
            {tool === "crop" ? (
              <>
                <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
                  <div className="border-b border-border/60 px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">Aspect Ratio</div>
                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      {ASPECT_PRESETS.map((preset) => (
                        <AspectButton
                          key={preset.key}
                          preset={preset}
                          active={aspectKey === preset.key}
                          onClick={() => commitAspect(preset.key)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="border-b border-border/60 px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">Transform</div>
                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        className="flex items-center justify-center gap-2 rounded-md bg-app px-3 py-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
                        onClick={() => commitTransform({ quarterTurns: ((quarterTurns - 1) % 4 + 4) % 4, freeAngle: 0 })}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        90° L
                      </button>
                      <button
                        type="button"
                        className="flex items-center justify-center gap-2 rounded-md bg-app px-3 py-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
                        onClick={() => commitTransform({ quarterTurns: (quarterTurns + 1) % 4, freeAngle: 0 })}
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        90° R
                      </button>
                      <button
                        type="button"
                        className={[
                          "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[11px] transition-colors",
                          flipX ? "bg-selected text-accent" : "bg-app text-muted hover:bg-hover hover:text-text",
                        ].join(" ")}
                        onClick={() => commitTransform({ flipX: !flipX })}
                      >
                        <FlipHorizontal2 className="h-3.5 w-3.5" />
                        Flip H
                      </button>
                      <button
                        type="button"
                        className={[
                          "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[11px] transition-colors",
                          flipY ? "bg-selected text-accent" : "bg-app text-muted hover:bg-hover hover:text-text",
                        ].join(" ")}
                        onClick={() => commitTransform({ flipY: !flipY })}
                      >
                        <FlipVertical2 className="h-3.5 w-3.5" />
                        Flip V
                      </button>
                    </div>
                  </div>

                  <div className="border-b border-border/60 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">Scale</div>
                      <div className="text-[11px] text-muted">{imageZoom.toFixed(2)}×</div>
                    </div>
                    <input
                      type="range"
                      min={String(getMinZoomForCrop(cropRect, transformedPreview, placement))}
                      max={String(MAX_IMAGE_ZOOM)}
                      step="0.01"
                      value={imageZoom}
                      onChange={(event) => {
                        if (!transformedPreview || !placement) return;
                        const next = clampImagePlacement(
                          {
                            ...editorStateRef.current,
                            imageZoom: Number(event.target.value),
                          },
                          transformedPreview,
                          placement,
                        );
                        recordState(next);
                      }}
                      className="mt-3 w-full"
                      aria-label="Image scale"
                    />
                  </div>

                </div>

                <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
                  <FooterButton icon={RotateCcw} label="Reset" onClick={handleReset} disabled={loadState !== "ready"} />
                  <FooterButton icon={Undo2} label="" onClick={handleUndo} disabled={historyIndex <= 0} />
                  <FooterButton icon={Redo2} label="" onClick={handleRedo} disabled={historyIndex < 0 || historyIndex >= history.length - 1} />
                  <div className="flex-1" />
                  <FooterButton icon={Check} label="Apply" onClick={handleApply} disabled={loadState !== "ready"} primary />
                </div>
              </>
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
            ) : null}
            {/* Always mounted so data loads when editor opens, hidden when not active */}
            <div className={tool === "ai" ? "flex max-h-[calc(100vh-10rem)] flex-col" : "hidden"}>
              <AiRepaintPanel sourcePath={sourcePath} sourceLabel={sourceLabel} onCompareChange={setCompareState} compareState={compareState} onRepaintComplete={onSaveComplete} />
            </div>
          </div>

          <div
            className="pointer-events-auto flex w-12 flex-col items-center gap-2 rounded-xl border border-border/60 bg-chrome/95 p-1.5 shadow-overlay backdrop-blur-xl"
            data-editor-wheel-scope="toolbar"
          >
            <ToolTab active={tool === "crop"} icon={Crop} label="Crop" onClick={() => { setTool("crop"); setDepthMapVisible(false); }} />
            <ToolTab active={tool === "text"} icon={Type} label="Text" onClick={() => setTool("text")} />
            <ToolTab active={tool === "sticker"} icon={Cannabis} label="Sticker" onClick={() => { setTool("sticker"); setDepthMapVisible(false); }} />
            <ToolTab active={tool === "ai"} icon={Sparkles} label="AI Repaint" onClick={() => { setTool("ai"); setDepthMapVisible(false); }} />
          </div>
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
