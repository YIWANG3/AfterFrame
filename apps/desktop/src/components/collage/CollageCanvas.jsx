import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { localFileUrl } from "../../utils/format";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const SNAP_THRESHOLD = 8; // display px

function getDrawSize(img, cellW, cellH, zoom) {
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const cellAspect = cellW / cellH;
  let drawW, drawH;
  if (imgAspect > cellAspect) {
    drawH = cellH * zoom;
    drawW = drawH * imgAspect;
  } else {
    drawW = cellW * zoom;
    drawH = drawW / imgAspect;
  }
  return { drawW, drawH };
}

function drawCellImage(ctx, img, cellRect, pan, zoom, borderRadius) {
  const { x, y, w, h } = cellRect;
  ctx.save();
  if (borderRadius > 0) {
    roundRectPath(ctx, x, y, w, h, borderRadius);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  const { drawW, drawH } = getDrawSize(img, w, h, zoom);
  const drawX = x + (w - drawW) / 2 + pan.x;
  const drawY = y + (h - drawH) / 2 + pan.y;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function uniqueSortedBreakpoints(values, tol = 0.001) {
  const arr = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of arr) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  return out;
}

function findBreakIndex(breakpoints, v, tol = 0.001) {
  for (let i = 0; i < breakpoints.length; i++) {
    if (Math.abs(breakpoints[i] - v) < tol) return i;
  }
  return -1;
}

function computeTracks(breakpoints, innerSize, gap) {
  // CSS-Grid style: reserve (N-1)*gap total, distribute remaining space
  // proportionally to each track's ratio. Tracks with equal ratio end up
  // at equal pixel size regardless of position — no shrinkage on inner cells.
  const N = breakpoints.length - 1;
  const totalGap = Math.max(0, (N - 1) * gap);
  const effective = Math.max(0, innerSize - totalGap);
  const tracks = [];
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const ratio = breakpoints[i + 1] - breakpoints[i];
    const size = Math.max(0, ratio * effective);
    tracks.push({ start: cursor, size });
    cursor += size + gap;
  }
  return tracks;
}

function computeCellRects(cells, canvasW, canvasH, gap, padding = 0) {
  const innerW = Math.max(0, canvasW - padding * 2);
  const innerH = Math.max(0, canvasH - padding * 2);
  const xVals = [0, 1];
  const yVals = [0, 1];
  for (const c of cells) {
    xVals.push(c.x, c.x + c.w);
    yVals.push(c.y, c.y + c.h);
  }
  const xBreaks = uniqueSortedBreakpoints(xVals);
  const yBreaks = uniqueSortedBreakpoints(yVals);
  const xTracks = computeTracks(xBreaks, innerW, gap);
  const yTracks = computeTracks(yBreaks, innerH, gap);
  return cells.map((cell) => {
    const sx = findBreakIndex(xBreaks, cell.x);
    const ex = findBreakIndex(xBreaks, cell.x + cell.w);
    const sy = findBreakIndex(yBreaks, cell.y);
    const ey = findBreakIndex(yBreaks, cell.y + cell.h);
    const xStart = xTracks[sx].start;
    const yStart = yTracks[sy].start;
    const xEnd = xTracks[ex - 1].start + xTracks[ex - 1].size;
    const yEnd = yTracks[ey - 1].start + yTracks[ey - 1].size;
    return {
      x: padding + xStart,
      y: padding + yStart,
      w: xEnd - xStart,
      h: yEnd - yStart,
    };
  });
}

export const COLLAGE_ZOOM_MIN = MIN_ZOOM;
export const COLLAGE_ZOOM_MAX = MAX_ZOOM;

const CollageCanvas = forwardRef(function CollageCanvas(
  { images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth, className, onSwap, onReplace, onSelectionChange, onSelectedStateChange },
  ref,
) {
  const { t } = useTranslation("collage");
  const canvasRef = useRef(null);
  const loadedImgsRef = useRef(new Map());
  const cellStatesRef = useRef([]); // { pan: {x,y}, zoom }
  const rafRef = useRef(0);
  const dragRef = useRef(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [snapGuides, setSnapGuides] = useState({ x: false, y: false });

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onSelectedStateChangeRef = useRef(onSelectedStateChange);
  onSelectedStateChangeRef.current = onSelectedStateChange;

  // Emit selection changes to parent
  useEffect(() => {
    onSelectionChangeRef.current?.(selectedIdx);
    if (selectedIdx >= 0) {
      const state = cellStatesRef.current[selectedIdx];
      if (state) onSelectedStateChangeRef.current?.({ pan: { ...state.pan }, zoom: state.zoom });
    }
  }, [selectedIdx]);

  function emitSelectedState() {
    if (selectedIdx < 0) return;
    const state = cellStatesRef.current[selectedIdx];
    if (state) onSelectedStateChangeRef.current?.({ pan: { ...state.pan }, zoom: state.zoom });
  }
  // Store latest props in refs so redraw/handlers always see current values
  const propsRef = useRef({ images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth });
  propsRef.current = { images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth };

  // Sync cell states count with template
  useEffect(() => {
    const count = template?.cells?.length || 0;
    const prev = cellStatesRef.current;
    const next = [];
    for (let i = 0; i < count; i++) {
      next.push(prev[i] || { pan: { x: 0, y: 0 }, zoom: 1 });
    }
    cellStatesRef.current = next;
    if (selectedIdx >= count) setSelectedIdx(-1);
  }, [template, images.length]);

  function getPreviewSrc(item) {
    if (!item) return null;
    return item.preview_hd_path || item.export_preview_hd_path || item.preview_path || item.export_preview_path || item.export_path;
  }

  function redraw() {
    const canvas = canvasRef.current;
    const { template: tmpl, gap: g, padding: p, borderRadius: br, bgColor: bg, images: imgs, exportWidth: ew } = propsRef.current;
    if (!canvas || !tmpl?.cells) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;
    if (displayW === 0 || displayH === 0) return;

    const scale = displayW / (ew || 3000);

    const needW = Math.round(displayW * dpr);
    const needH = Math.round(displayH * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = bg || "#000000";
    ctx.fillRect(0, 0, displayW, displayH);

    const cellRects = computeCellRects(tmpl.cells, displayW, displayH, g * scale, (p || 0) * scale);
    const map = loadedImgsRef.current;

    const displayBr = br * scale;
    for (let i = 0; i < cellRects.length; i++) {
      const rect = cellRects[i];
      const src = getPreviewSrc(imgs[i]);
      const img = src ? map.get(src) : null;
      const state = cellStatesRef.current[i] || { pan: { x: 0, y: 0 }, zoom: 1 };
      if (img && img.complete && img.naturalWidth > 0) {
        drawCellImage(ctx, img, rect, state.pan, state.zoom, displayBr);
      } else {
        ctx.save();
        if (displayBr > 0) { roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, displayBr); ctx.clip(); }
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
      }
    }

    // Selection ring
    if (selectedIdx >= 0 && selectedIdx < cellRects.length) {
      const r = cellRects[selectedIdx];
      ctx.save();
      const accentRaw = getComputedStyle(canvas).getPropertyValue("--accent-color").trim() || "210 160 90";
      const accent = accentRaw.replace(/\s+/g, ",");
      ctx.strokeStyle = `rgb(${accent})`;
      ctx.lineWidth = 2;
      if (displayBr > 0) {
        roundRectPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.max(0, displayBr - 1));
        ctx.stroke();
      } else {
        ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      }
      // Snap guides
      if (snapGuides.x || snapGuides.y) {
        ctx.strokeStyle = `rgba(${accent},0.7)`;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        if (snapGuides.x) {
          const cx = r.x + r.w / 2;
          ctx.beginPath();
          ctx.moveTo(cx, r.y);
          ctx.lineTo(cx, r.y + r.h);
          ctx.stroke();
        }
        if (snapGuides.y) {
          const cy = r.y + r.h / 2;
          ctx.beginPath();
          ctx.moveTo(r.x, cy);
          ctx.lineTo(r.x + r.w, cy);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function scheduleRedraw() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      redraw();
    });
  }

  // Redraw on selection changes / guide changes
  useEffect(() => { scheduleRedraw(); }, [selectedIdx, snapGuides.x, snapGuides.y]);

  // Load images
  useEffect(() => {
    const map = loadedImgsRef.current;
    const needed = new Set();
    for (const item of images) {
      const src = getPreviewSrc(item);
      if (!src) continue;
      needed.add(src);
      if (!map.has(src)) {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.src = localFileUrl(src);
        el.onload = () => scheduleRedraw();
        map.set(src, el);
      }
    }
    for (const key of map.keys()) {
      if (!needed.has(key)) map.delete(key);
    }
    scheduleRedraw();
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; } };
  }, [images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth]);

  // Hit test
  function hitTest(px, py) {
    const canvas = canvasRef.current;
    const { template: tmpl, gap: g, padding: p, exportWidth: ew } = propsRef.current;
    if (!canvas || !tmpl?.cells) return -1;
    const s = canvas.clientWidth / (ew || 3000);
    const rects = computeCellRects(tmpl.cells, canvas.clientWidth, canvas.clientHeight, g * s, (p || 0) * s);
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
    }
    return -1;
  }

  // Pointer handlers
  const onSwapRef = useRef(onSwap);
  onSwapRef.current = onSwap;
  const onReplaceRef = useRef(onReplace);
  onReplaceRef.current = onReplace;
  const [ctxMenu, setCtxMenu] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onPointerDown(e) {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = hitTest(px, py);
      if (idx < 0) {
        setSelectedIdx(-1);
        return;
      }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      const state = cellStatesRef.current[idx] || { pan: { x: 0, y: 0 }, zoom: 1 };
      dragRef.current = {
        idx,
        startX: e.clientX,
        startY: e.clientY,
        startPan: { x: state.pan.x, y: state.pan.y },
        moved: false,
        shift: e.shiftKey,
      };
      // Selection always follows the cell being interacted with — snap guides,
      // panel controls and slider all track the dragged cell, not whatever
      // was selected before.
      if (idx !== selectedIdx) setSelectedIdx(idx);
    }

    function onPointerMove(e) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (!d.moved) return;

      const state = cellStatesRef.current[d.idx];
      let newPan = { x: d.startPan.x + dx, y: d.startPan.y + dy };

      // Snap to center (hold Shift to bypass)
      const useSnap = !e.shiftKey;
      let gx = false, gy = false;
      if (useSnap) {
        if (Math.abs(newPan.x) < SNAP_THRESHOLD) { newPan.x = 0; gx = true; }
        if (Math.abs(newPan.y) < SNAP_THRESHOLD) { newPan.y = 0; gy = true; }
      }
      if (gx !== snapGuides.x || gy !== snapGuides.y) setSnapGuides({ x: gx, y: gy });

      state.pan = newPan;
      redraw();
    }

    function onPointerUp(e) {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      canvas.style.cursor = "grab";
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      setSnapGuides({ x: false, y: false });

      if (!d.moved) {
        // Click → select
        setSelectedIdx(d.idx);
        return;
      }

      // Released over a different cell → swap
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const targetIdx = hitTest(px, py);
      if (targetIdx >= 0 && targetIdx !== d.idx) {
        cellStatesRef.current[d.idx] = {
          ...cellStatesRef.current[d.idx],
          pan: { x: d.startPan.x, y: d.startPan.y },
        };
        const tmp = cellStatesRef.current[d.idx];
        cellStatesRef.current[d.idx] = cellStatesRef.current[targetIdx] || { pan: { x: 0, y: 0 }, zoom: 1 };
        cellStatesRef.current[targetIdx] = tmp;
        onSwapRef.current?.(d.idx, targetIdx);
      } else {
        // Dragged within same cell → keep selection on it
        if (selectedIdx === d.idx) emitSelectedState();
        else setSelectedIdx(d.idx);
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Prefer selected cell so pinch zooms what the panel slider controls,
      // even if cursor drifts. Fall back to hit-test.
      const idx = selectedIdx >= 0 ? selectedIdx : hitTest(px, py);
      if (idx < 0) return;
      // Mac trackpad pinch fires wheel with ctrlKey=true and small deltaY.
      // Use exponential factor for smooth, proportional response.
      const isPinch = e.ctrlKey;
      let factor;
      if (isPinch) {
        factor = Math.exp(-e.deltaY * 0.01);
      } else if (e.shiftKey) {
        factor = e.deltaY > 0 ? 0.985 : 1.015;
      } else {
        factor = e.deltaY > 0 ? 0.94 : 1.06;
      }
      const state = cellStatesRef.current[idx] || { pan: { x: 0, y: 0 }, zoom: 1 };
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * factor));
      cellStatesRef.current[idx] = { ...state, zoom: newZoom };
      // Auto-select the cell being pinched, so the slider tracks it
      if (idx !== selectedIdx) setSelectedIdx(idx);
      else if (idx === selectedIdx) emitSelectedState();
      redraw();
    }

    function onContextMenu(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = hitTest(px, py);
      if (idx >= 0) {
        setCtxMenu({ x: e.clientX, y: e.clientY, cellIndex: idx });
      }
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [template, gap, padding, exportWidth, selectedIdx, snapGuides.x, snapGuides.y]);

  // Keyboard: arrows nudge selected cell pan, esc deselects
  useEffect(() => {
    if (selectedIdx < 0) return;
    function onKey(e) {
      if (e.key === "Escape") {
        setSelectedIdx(-1);
        return;
      }
      const step = e.shiftKey ? 1 : 8;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      const state = cellStatesRef.current[selectedIdx];
      if (!state) return;
      state.pan = { x: state.pan.x + dx, y: state.pan.y + dy };
      emitSelectedState();
      redraw();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx]);

  // Export at target resolution + cell controls for panel
  useImperativeHandle(ref, () => ({
    setSelectedZoom(z) {
      if (selectedIdx < 0) return;
      const state = cellStatesRef.current[selectedIdx];
      if (!state) return;
      state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      emitSelectedState();
      redraw();
    },
    centerSelected() {
      if (selectedIdx < 0) return;
      const state = cellStatesRef.current[selectedIdx];
      if (!state) return;
      state.pan = { x: 0, y: 0 };
      emitSelectedState();
      redraw();
    },
    resetSelected() {
      if (selectedIdx < 0) return;
      cellStatesRef.current[selectedIdx] = { pan: { x: 0, y: 0 }, zoom: 1 };
      emitSelectedState();
      redraw();
    },
    deselect() {
      setSelectedIdx(-1);
    },
    async exportToBlob(targetWidth = 3000) {
      const { template: tmpl, canvasRatio: ratio, gap: g, padding: p, borderRadius: br, bgColor: bg, images: imgs, exportWidth: ew } = propsRef.current;
      if (!tmpl?.cells) return null;
      const targetH = Math.round(targetWidth / (ratio || 1));
      const offscreen = document.createElement("canvas");
      offscreen.width = targetWidth;
      offscreen.height = targetH;
      const ctx = offscreen.getContext("2d");
      ctx.fillStyle = bg || "#000000";
      ctx.fillRect(0, 0, targetWidth, targetH);

      const displayW = canvasRef.current?.clientWidth || 800;
      const panScale = targetWidth / displayW;
      const cellRects = computeCellRects(tmpl.cells, targetWidth, targetH, g, p || 0);
      const map = loadedImgsRef.current;

      for (let i = 0; i < cellRects.length; i++) {
        const rect = cellRects[i];
        const src = getPreviewSrc(imgs[i]);
        const img = src ? map.get(src) : null;
        const state = cellStatesRef.current[i] || { pan: { x: 0, y: 0 }, zoom: 1 };
        if (img && img.complete && img.naturalWidth > 0) {
          drawCellImage(ctx, img, rect, { x: state.pan.x * panScale, y: state.pan.y * panScale }, state.zoom, br);
        }
      }
      return new Promise((resolve) => offscreen.toBlob(resolve, "image/jpeg", 0.92));
    },
  }), [selectedIdx]);

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [ctxMenu]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className={className}
        style={{ cursor: "grab", touchAction: "none" }}
      />

      {ctxMenu && (
        <div
          className="fixed z-[100] min-w-[120px] rounded-lg border border-border/60 bg-chrome py-1 shadow-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-hover"
            onClick={() => {
              const idx = ctxMenu.cellIndex;
              setCtxMenu(null);
              onReplaceRef.current?.(idx);
            }}
          >
            {t("collage.replace")}
          </button>
        </div>
      )}
    </div>
  );
});

export default CollageCanvas;
