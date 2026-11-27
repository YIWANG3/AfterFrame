// Test backdoor — lets the e2e specs drive the editor (save to a known path,
// switch tools, read state …) without the native dialogs. The methods are
// merged into window.__afterframeTest beside App's (openEditor, closeEditor,
// getEditorOpen …) while the editor is open.
//
// The method table is rebuilt every render so each closure sees the current
// state, and installed once per open through a ref: re-installing on every
// state change (the old shape) left gaps a polling spec could land in. The
// handles bag is therefore read fresh on every call, never captured.

import { useEffect, useRef } from "react";
import { getSourceDimensions } from "./render/canvasHelpers";
import { getStageBounds } from "./imageMath";
import { resolveSplitOutputDir } from "./state/useSplitExport";
import { stateEquals } from "./state/editorStateModel";
import { layersEqual } from "./state/useEditorHistory";

// An edit lands in editorStateRef / layersRef at once and in the rendered
// state a render later, and a save reads the rendered state (EditorOverlay's
// buildSaveArgs). A backdoor call runs outside React's events, so that render
// waits for a task of its own, and a spec that polled getState() (the refs)
// could save a frame early: an undone rotation still rotated, a 1:1 crop
// uncropped (18-editor-transform on CI, 2026-11-24 and 11-27). Wait until the
// rendered transform and layer state equal the refs, on two checks in a row
// so a commit made by an effect of that render is waited for too. Pictures
// those layers load (a new sticker's decode, a font) are not waited for.
async function renderCaughtUp(latest, timeoutMs = 5000) {
  const caughtUp = () => {
    const h = latest();
    return stateEquals(h.editorState, h.editorStateRef.current) && layersEqual(h.layers, h.layersRef.current);
  };
  const deadline = performance.now() + timeoutMs;
  for (let inARow = 0; inARow < 2;) {
    inARow = caughtUp() ? inARow + 1 : 0;
    if (inARow === 2) return;
    // A save of an older state would fail the way the race did; say why.
    if (performance.now() > deadline) throw new Error(`saveAs: the editor had not rendered its latest state after ${timeoutMs} ms`);
    await nextTask();
  }
}

// A task of its own, posted the way React's scheduler posts its renders and
// effects, so those already queued run first. Not a timer: a window that is
// hidden or covered gets its timers throttled to one a second. One channel,
// one message per waiter, answered in order.
let taskChannel = null;
const taskWaiters = [];
function nextTask() {
  if (!taskChannel) {
    taskChannel = new MessageChannel();
    taskChannel.port1.onmessage = () => taskWaiters.shift()?.();
  }
  return new Promise((resolve) => {
    taskWaiters.push(resolve);
    taskChannel.port2.postMessage(null);
  });
}

// `latest()` is the handles bag of the latest render, for a method that
// awaits: its own `h` is the one of the render it was called in.
function buildEditorTestApi(h, latest) {
  return {
    // The save runs the latest executeSave (executeSaveRef) once the render
    // has caught up with the edits before it (renderCaughtUp).
    saveAs: async (path) => {
      await renderCaughtUp(latest);
      return latest().executeSaveRef.current?.(path);
    },
    // Preview decoded. 18-editor-transform polls this while it deliberately
    // holds back viewport measurements, so it must not imply a measured stage.
    getPreviewReady: () => h.previewReady,
    // Ready to EDIT: preview decoded AND the initial snapshot is in history.
    // waitForEditor({ preview: true }) waits for this — on a slow runner the
    // viewport measures late, the base snapshot lands after the test's first
    // edit, and an undo at history index 0 is a no-op (CI 19-editor-layers,
    // 2026-09-17). And reset for this photo: a reopened editor still holds
    // the last session's preview and snapshot until its picture is decided
    // (a RAW's HD, seconds on an Intel Mac), and an edit made then is wiped.
    getEditReady: () => h.resetItemRef.current === h.itemKey && h.previewReady && !!h.baseSnapshotRef.current,
    sampleSourcePixel: (fx = 0.5, fy = 0.5) => {
      const source = h.sourceImageRef.current;
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
    addTextLayer: (text) => h.addTextLayer(text),
    setTestLayers: (next) => h.commitLayers(next),
    loadTestDepth: (path) => h.loadDepthFromPath(path),
    getLayerCount: () => h.layers.length,
    getTool: () => h.tool,
    setTool: (t) => h.setTool(t),
    // Characterization backdoor for the refactor safety-net (Phase 0).
    getState: () => {
      const s = h.editorStateRef.current;
      return {
        tool: h.tool,
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
        cropRectRendered: h.cropRect,
        // `layers` is the STORED (full-photo) basis; `displayLayers` is the
        // derived current-basis position shown on screen.
        layers: h.layers.map((l) => ({
          id: l.id, type: l.type, x: l.x, y: l.y, scale: l.scale,
          naturalWidth: l.naturalWidth, naturalHeight: l.naturalHeight,
          // Text styling the panel/gesture specs assert on.
          text: l.text, fontFamily: l.fontFamily, fontSize: l.fontSize, italic: l.italic, fillColor: l.fillColor, rotation: l.rotation,
          strokeEnabled: !!l.strokeEnabled, strokeWidth: l.strokeWidth, shadow: !!l.shadow, shadowX: l.shadowX, bgMode: l.bgMode,
          bgRadius: l.bgRadius, fromPreset: !!l.fromPreset,
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
        displayLayers: h.displayLayers.map((l) => ({ id: l.id, x: l.x, y: l.y })),
        selectedIds: [...h.selectedIds],
        historyIndex: h.historyIndexRef.current,
        historyLength: h.historyRef.current.length,
        canvasPad: s.canvas?.pad,
        canvasBg: s.canvas?.bg || null,
        canvasAspect: s.canvas?.aspect ?? null,
        canvasPhoto: s.canvas?.photo ?? null,
        canvasMockup: s.canvas?.mockup ?? null,
        imageRect: h.imageRect,
        outputRect: h.screenOutputRect,
        outputContentRect: h.screenOutputView?.contentRect || null,
        viewTransform: h.viewTransform,
        placement: h.placement,
        stageBounds: getStageBounds(h.viewportSize),
      };
    },
    setAspect: (key) => h.commitAspect(key),
    setPad: (pad) => {
      h.applyCanvasPad({ top: 0, right: 0, bottom: 0, left: 0, ...pad }, { record: true });
    },
    clearFramePreset: () => h.clearFramePreset(),
    applyFramePreset: (templateId) => {
      const tpl = h.frameToolRef.current?.templates?.find((x) => x.id === templateId);
      return tpl ? h.applyFramePreset(tpl) : undefined;
    },
    deleteLayer: (id) => h.deleteLayer(id),
    moveLayer: (id, dir) => h.moveLayer(id, dir),
    selectLayers: (ids) => h.selectLayers(ids),
    undo: () => h.undo(),
    redo: () => h.redo(),
    // LUT tool (docs/lut-plan.md): getLutState, refreshLuts — the hook's own.
    ...h.lutTool.testApi,
    // The preview as drawn (graded at the current strength), 0..1 coords.
    sampleDisplayPixel: (fx = 0.5, fy = 0.5) => {
      const canvas = h.imageCanvasRef.current;
      if (!canvas?.width) return null;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * (canvas.width - 1))));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * (canvas.height - 1))));
      return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
    },
    // Split tool (read through refs so the values are always current).
    getSplitState: () => {
      const st = h.splitToolRef.current;
      const dest = h.splitDestRef.current;
      return {
        aspectKey: st.aspectKey, count: st.count, isAutoCount: st.isAutoCount,
        rect: st.rect, rectPx: st.rectPx, splitImageRect: st.splitImageRect,
        custom: st.custom,
        outputDir: dest.outputDir, subfolder: dest.subfolder,
        resolvedOutputDir: resolveSplitOutputDir(h.saveBasePath, dest.outputDir, dest.subfolder),
        exporting: h.splitExportingRef.current,
      };
    },
    exportSplit: (dir, subfolder) => h.splitExportRef.current?.(
      dir ?? h.splitDestRef.current.outputDir, subfolder ?? h.splitDestRef.current.subfolder,
    ),
  };
}

// `handles` is the bag of refs, values and callbacks the methods read; pass
// it fresh on every render.
export function useEditorTestApi(open, handles) {
  const handlesRef = useRef(handles);
  handlesRef.current = handles;
  const testApiRef = useRef(null);
  testApiRef.current = buildEditorTestApi(handles, () => handlesRef.current);

  useEffect(() => {
    if (!open) return undefined;
    const keys = Object.keys(testApiRef.current);
    const target = (window.__afterframeTest = window.__afterframeTest || {});
    for (const k of keys) target[k] = (...args) => testApiRef.current[k](...args);
    return () => {
      for (const k of keys) delete target[k];
    };
  }, [open]);
}
