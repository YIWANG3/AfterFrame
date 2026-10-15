import api from "../api";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clamp, fileName } from "../utils/format";
import { needsOnDemandHd, useOnDemandHdPreview } from "../hooks/useOnDemandHdPreviews";
import useRawEditSource, { useNeutralRawRender } from "../hooks/useRawEditSource";
import AiRepaintPanel from "./editor/AiRepaintPanel";
import BeforeAfterCompare from "./editor/BeforeAfterCompare";
import TextPanel from "./editor/TextPanel";
import TextCanvas from "./editor/TextCanvas";
import StickerPanel from "./editor/StickerPanel";
import { useFrameTool } from "./editor/state/useFrameTool";
import { useFramePlacement } from "./editor/state/useFramePlacement";
import { useEditorTestApi } from "./editor/editorTestApi";
import {
  getSourceDimensions,
  releaseCanvasImage,
  buildPreviewSource,
  buildDepthMaskCanvas,
  buildTransformedCanvas,
  bgToCss,
} from "./editor/render/canvasHelpers";
import { drawLayersOnCanvas } from "./editor/render/drawLayers";
import { createOverlayLayer } from "./editor/textState";
import { isFrameLayer } from "./editor/layerStack";
import { bakeCrop } from "./editor/render/bakeCrop";
import StickerRegionOverlay from "./editor/components/StickerRegionOverlay";
import EditorHeader from "./editor/components/EditorHeader";
import EditorLoading from "./editor/components/EditorLoading";
import ToolRail from "./editor/components/ToolRail";
import PanelChrome from "./editor/components/PanelChrome";
import CropPanel from "./editor/components/CropPanel";
import CropOverlay from "./editor/components/CropOverlay";
import AngleRuler from "./editor/components/AngleRuler";
import SplitPanel from "./editor/components/SplitPanel";
import SplitOverlay from "./editor/components/SplitOverlay";
import LutPanel from "./editor/LutPanel";
import { useLutTool } from "./editor/state/useLutTool";
import { fullSizeParallelism, gradeCanvas } from "./editor/lut/lutPool";
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
import { usePref } from "../hooks/usePref";
import { bool, text } from "../utils/prefs";
import { matchShortcut } from "../shortcuts/store";
import {
  PANEL_WIDTH,
  PANEL_GAP,
  CANVAS_SIDE_PADDING,
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

function padEquals(a, b) {
  const pa = { top: 0, right: 0, bottom: 0, left: 0, ...(a || {}) };
  const pb = { top: 0, right: 0, bottom: 0, left: 0, ...(b || {}) };
  return pa.top === pb.top && pa.right === pb.right && pa.bottom === pb.bottom && pa.left === pb.left;
}

const SPLIT_DIR_PREF = "split.outputDir";
const SPLIT_SUBFOLDER_PREF = "split.subfolder";

// Whether a remembered folder is still there (an unplugged drive, a deleted
// folder: back to the original's folder).
async function dirExists(dir) {
  if (!api.has?.("statDirs")) return false;
  const found = await api.statDirs([dir]).catch(() => []);
  return !!found?.includes(dir);
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
  // next photo (utils/prefs.js); a remembered folder is used only once it has
  // been seen on disk for this photo, so one that is gone is dropped.
  const [splitDirPref, setSplitDirPref, forgetSplitDir] = usePref(SPLIT_DIR_PREF, null, text(4096));
  const [splitSubfolder, setSplitSubfolder] = usePref(SPLIT_SUBFOLDER_PREF, true, bool);
  const [splitDirSeen, setSplitDirSeen] = useState(null);
  const splitOutputDir = splitDirPref && splitDirSeen === splitDirPref ? splitDirPref : null;
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
  const lutAvailable = api.can("lut");
  const itemKey = item?.asset_id ?? item?.image_path ?? null;
  // A tool belongs to the photo it was picked on. The editor stays mounted
  // when closed, and the reset below waits for the next photo's picture, so
  // until then the last tool would still be current: a RAW opened after a
  // session that ended in the LUT tool asked for Apple's render at once, and
  // opened on it when that came back before its HD. Reopened, or on the next
  // photo, the editor is on Crop from the first render.
  const toolOwner = open ? itemKey : null;
  const [toolFor, setToolFor] = useState(toolOwner);
  if (toolFor !== toolOwner) {
    setToolFor(toolOwner);
    setTool("crop");
  }
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
    promoteBakedSource(composite, "Text applied");
    layerResetHard();
  }

  // A baked canvas (the crop applied, the layers burnt in) becomes the working
  // picture: later saves start from it (the native fast path is off — the file
  // on disk no longer matches), the history is wiped and re-seeded by the
  // initial-snapshot effect, and the LUT, which is not baked, carries over as
  // the first step after the base.
  function promoteBakedSource(canvas, message) {
    const nextPreview = buildPreviewSource(canvas);
    const previousSource = sourceImageRef.current;
    sourceImageRef.current = canvas;
    setSourceImage(canvas);
    setPreviewSource(nextPreview);
    nativeSaveSourcePathRef.current = null;
    carryLutRef.current = editorStateRef.current.lut;
    setBakedItem(itemKey);
    releaseCanvasImage(previousSource);
    baseSnapshotRef.current = null;
    quickSavePathRef.current = null;
    syncHistory([], -1);
    applyState(BASE_STATE);
    setViewTransform(IDENTITY_VIEW_TRANSFORM); // review F4: drop the old fit
    setMessage(message);
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
    setSplitDirSeen(null);
    const splitDir = splitDirPref;
    if (splitDir) void dirExists(splitDir).then((found) => { if (active && found) setSplitDirSeen(splitDir); });
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
    setSplitDirPref(dir);
    setSplitDirSeen(dir);
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

  const {
    placePersonalLogo, placeCameraLogo, chooseCameraLogo, addFrameText, saveFrameTemplate,
    logoDropActive, handleLogoDrop, handleLogoDragOver, handleLogoDragLeave,
  } = useFramePlacement({
    transformedPreview, normalizedCrop, editorStateRef, layersRef, stickerImageCache, frameToolRef,
    commitLayers, setSelectedIds, setTool, pushToast, t,
  });

  // e2e backdoor (editorTestApi.js): the handles are passed fresh each render.
  useEditorTestApi(open, {
    executeSaveRef, previewReady: !!previewSource, resetItemRef, itemKey, baseSnapshotRef, sourceImageRef,
    addTextLayer, commitLayers, loadDepthFromPath, layers, tool, setTool,
    editorStateRef, cropRect, displayLayers, selectedIds, historyIndexRef, historyRef,
    imageRect, screenOutputRect, screenOutputView, viewTransform, placement, viewportSize,
    commitAspect, applyCanvasPad, clearFramePreset, applyFramePreset, frameToolRef,
    deleteLayer: handleDeleteLayer, moveLayer: handleMoveLayer, selectLayers, undo: handleUndo, redo: handleRedo,
    lutGradedTransformed, lutTool, lutBase, sourcePath, imageCanvasRef,
    splitToolRef, splitDestRef, splitExportingRef, splitExportRef, saveBasePath,
  });

  function handleApply() {
    flushLayerCommit();
    if (!sourceImage || !cropRect || !imageRect) return;
    const normalized = normalizedCrop;
    if (!normalized) return;

    // Re-base layers to the baked photo BEFORE the source swaps: the cropped
    // content becomes the new full photo, so full-photo coords are re-expressed
    // relative to the crop sub-rect (review F4). Storage has no pad → pad {}.
    const bakedLayers = bakeLayersIntoCrop(currentLayerHead(), transformedPreview, normalized, {});

    // The crop cut out of the full-resolution source becomes the working picture.
    const cropped = bakeCrop(sourceImage, { cropRect, imageRect, discreteRotationDeg, flipX, flipY, freeAngle });
    promoteBakedSource(cropped, "Applied");
    applyLayers(bakedLayers); // history was just wiped; initial-snapshot effect will record it
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
      onDragOver={handleLogoDragOver}
      onDragLeave={handleLogoDragLeave}
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
                onSubfolderChange={setSplitSubfolder}
                onChooseFolder={chooseSplitFolder}
                onUseOriginalFolder={splitOutputDir ? forgetSplitDir : null}
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
