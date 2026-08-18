import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
  { images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth, className, mode = "single", highlightCell = -1, dimCell = -1, sharedStates, onSwap, onReplace, onRemove, onCellDragOut, onSelectionChange, onSelectedStateChange },
  ref,
) {
  const { t } = useTranslation("collage");
  const canvasRef = useRef(null);
  const loadedImgsRef = useRef(new Map());
  // Per-image pan/zoom, keyed by image identity (not cell index) so the state
  // follows the photo through swaps, template changes and HD-preview patches.
  // Batch mode passes one shared Map to every page canvas, so a photo keeps
  // its pan/zoom when it is swapped onto another page.
  const localStatesRef = useRef(new Map()); // key -> { pan: {x,y}, zoom }
  const cellStatesRef = useRef(localStatesRef.current);
  cellStatesRef.current = sharedStates || localStatesRef.current;
  const isSharedRef = useRef(false);
  isSharedRef.current = !!sharedStates;
  const DEFAULT_STATE = () => ({ pan: { x: 0, y: 0 }, zoom: 1 });
  const stateKey = (item, i) => item?.asset_id || item?.image_path || `#${i}`;
  // Stable accessors (only touch refs) so effects can list them as deps.
  const getState = useCallback((i) => {
    const item = propsRef.current.images[i];
    return cellStatesRef.current.get(stateKey(item, i)) || DEFAULT_STATE();
  }, []);
  const setState = useCallback((i, next) => {
    const item = propsRef.current.images[i];
    cellStatesRef.current.set(stateKey(item, i), next);
  }, []);
  const rafRef = useRef(0);
  const dragRef = useRef(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [snapGuides, setSnapGuides] = useState({ x: false, y: false });

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onSelectedStateChangeRef = useRef(onSelectedStateChange);
  onSelectedStateChangeRef.current = onSelectedStateChange;

  // Emit selection changes to parent
  // Store latest props in refs so redraw/handlers always see current values
  const propsRef = useRef({ images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth, highlightCell, dimCell });
  propsRef.current = { images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth, highlightCell, dimCell };

  useEffect(() => {
    onSelectionChangeRef.current?.(selectedIdx);
    if (selectedIdx >= 0) {
      const state = getState(selectedIdx);
      onSelectedStateChangeRef.current?.({ pan: { ...state.pan }, zoom: state.zoom });
    }
  }, [selectedIdx, getState]);

  function emitSelectedState() {
    if (selectedIdx < 0) return;
    const state = getState(selectedIdx);
    onSelectedStateChangeRef.current?.({ pan: { ...state.pan }, zoom: state.zoom });
  }

  // Drop states for images no longer on this canvas (a shared store is owned
  // by the parent and pruned there); clamp selection.
  useEffect(() => {
    const count = template?.cells?.length || 0;
    if (!isSharedRef.current) {
      const live = new Set(images.slice(0, count).map((it, i) => stateKey(it, i)));
      for (const key of localStatesRef.current.keys()) {
        if (!live.has(key)) localStatesRef.current.delete(key);
      }
    }
    if (selectedIdx >= count) setSelectedIdx(-1);
  }, [template, images]);

  // Candidate sources for a cell, best first. The HD preview is generated
  // lazily and patched in later; until it has actually decoded we keep
  // drawing the thumbnail so the upgrade is a seamless swap, not a flash.
  function getPreviewCandidates(item) {
    if (!item) return [];
    const out = [];
    for (const src of [
      item.preview_hd_path, item.image_preview_hd_path,
      item.preview_path, item.image_preview_path,
      item.image_path,
    ]) {
      if (src && !out.includes(src)) out.push(src);
    }
    return out;
  }

  function isReady(img) {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  // Best already-decoded image for a cell (HD if ready, else thumbnail…).
  function getLoadedImage(item) {
    const map = loadedImgsRef.current;
    for (const src of getPreviewCandidates(item)) {
      const img = map.get(src);
      if (isReady(img)) return img;
    }
    return null;
  }

  function redraw() {
    const canvas = canvasRef.current;
    const { template: tmpl, gap: g, padding: p, borderRadius: br, bgColor: bg, images: imgs, exportWidth: ew, highlightCell: hl, dimCell: dim } = propsRef.current;
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

    const displayBr = br * scale;
    for (let i = 0; i < cellRects.length; i++) {
      const rect = cellRects[i];
      const img = getLoadedImage(imgs[i]);
      const state = getState(i);
      if (img) {
        drawCellImage(ctx, img, rect, state.pan, state.zoom, displayBr);
      } else {
        ctx.save();
        if (displayBr > 0) { roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, displayBr); ctx.clip(); }
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
      }
      // Cross-page drag feedback: source cell dims, hovered target gets a ring.
      if (i === dim) {
        ctx.save();
        if (displayBr > 0) { roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, displayBr); ctx.clip(); }
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
      }
      if (i === hl) {
        ctx.save();
        const accentRaw = getComputedStyle(canvas).getPropertyValue("--accent-color").trim() || "210 160 90";
        ctx.strokeStyle = `rgb(${accentRaw.replace(/\s+/g, ",")})`;
        ctx.lineWidth = 3;
        if (displayBr > 0) roundRectPath(ctx, rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3, Math.max(0, displayBr - 1.5));
        else { ctx.beginPath(); ctx.rect(rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3); }
        ctx.stroke();
        ctx.fillStyle = `rgba(${accentRaw.replace(/\s+/g, ",")},0.18)`;
        ctx.fill();
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

  // Redraw on selection changes / guide changes / drag feedback
  useEffect(() => { scheduleRedraw(); }, [selectedIdx, snapGuides.x, snapGuides.y, highlightCell, dimCell]);

  // Load images. Only the best candidate per cell is fetched, but every
  // candidate stays "needed" so a thumbnail that is already decoded survives
  // the moment its HD sibling appears — the cell keeps drawing the thumbnail
  // until the HD image finishes decoding, then swaps in place.
  useEffect(() => {
    const map = loadedImgsRef.current;
    const needed = new Set();
    const load = (src) => {
      if (map.has(src)) return;
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.src = localFileUrl(src);
      el.onload = () => scheduleRedraw();
      map.set(src, el);
    };
    for (const item of images) {
      const candidates = getPreviewCandidates(item);
      if (!candidates.length) continue;
      for (const src of candidates) needed.add(src);
      const best = candidates[0];
      load(best);
      // A photo that just arrived (e.g. swapped in from another page) has no
      // decoded source here yet; the small thumbnail lands far sooner than the
      // HD render, so fetch it too and let HD replace it when ready.
      if (!isReady(map.get(best)) && candidates[1]) load(candidates[1]);
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
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const onCellDragOutRef = useRef(onCellDragOut);
  onCellDragOutRef.current = onCellDragOut;
  const [ctxMenu, setCtxMenu] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const isBatch = mode === "batch";

    function cellRectAt(idx) {
      const { template: tmpl, gap: g, padding: p, exportWidth: ew } = propsRef.current;
      if (!tmpl?.cells) return null;
      const s = canvas.clientWidth / (ew || 3000);
      return computeCellRects(tmpl.cells, canvas.clientWidth, canvas.clientHeight, g * s, (p || 0) * s)[idx] || null;
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = hitTest(px, py);
      if (idx < 0) {
        if (!isBatch) setSelectedIdx(-1);
        return;
      }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      const state = getState(idx);
      dragRef.current = {
        idx,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startPan: { x: state.pan.x, y: state.pan.y },
        moved: false,
        handedOff: false,
      };
      // Selection always follows the cell being interacted with — snap guides,
      // panel controls and slider all track the dragged cell, not whatever
      // was selected before.
      if (!isBatch && idx !== selectedIdx) setSelectedIdx(idx);
    }

    function onPointerMove(e) {
      const d = dragRef.current;
      if (!d || d.handedOff) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (!d.moved) return;

      // Batch pages: dragging inside the cell pans; leaving the cell turns
      // the gesture into a swap, which the parent drives across pages. Undo
      // the partial pan so the photo snaps back, then hand off.
      if (isBatch) {
        const rect = canvas.getBoundingClientRect();
        const cell = cellRectAt(d.idx);
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const inside = cell && px >= cell.x && px <= cell.x + cell.w && py >= cell.y && py <= cell.y + cell.h;
        if (!inside) {
          d.handedOff = true;
          setState(d.idx, { ...getState(d.idx), pan: { ...d.startPan } });
          canvas.style.cursor = "grab";
          if (canvas.hasPointerCapture(d.pointerId)) canvas.releasePointerCapture(d.pointerId);
          redraw();
          onCellDragOutRef.current?.(d.idx, e);
          return;
        }
      }

      const state = getState(d.idx);
      let newPan = { x: d.startPan.x + dx, y: d.startPan.y + dy };

      // Snap to center (hold Shift to bypass)
      const useSnap = !e.shiftKey;
      let gx = false, gy = false;
      if (useSnap) {
        if (Math.abs(newPan.x) < SNAP_THRESHOLD) { newPan.x = 0; gx = true; }
        if (Math.abs(newPan.y) < SNAP_THRESHOLD) { newPan.y = 0; gy = true; }
      }
      if (!isBatch && (gx !== snapGuides.x || gy !== snapGuides.y)) setSnapGuides({ x: gx, y: gy });

      setState(d.idx, { ...state, pan: newPan });
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
      if (d.handedOff) return;
      if (!isBatch) setSnapGuides({ x: false, y: false });

      if (!d.moved) {
        // Click → select (single mode only)
        if (!isBatch) setSelectedIdx(d.idx);
        return;
      }
      if (isBatch) return; // pan committed live

      // Released over a different cell → swap
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const targetIdx = hitTest(px, py);
      if (targetIdx >= 0 && targetIdx !== d.idx) {
        // Undo the live pan; states are keyed by image so they follow the swap.
        setState(d.idx, { ...getState(d.idx), pan: { x: d.startPan.x, y: d.startPan.y } });
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
      const idx = !isBatch && selectedIdx >= 0 ? selectedIdx : hitTest(px, py);
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
      const state = getState(idx);
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * factor));
      setState(idx, { ...state, zoom: newZoom });
      if (!isBatch) {
        // Auto-select the cell being pinched, so the slider tracks it
        if (idx !== selectedIdx) setSelectedIdx(idx);
        else emitSelectedState();
      }
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
  }, [template, gap, padding, exportWidth, selectedIdx, snapGuides.x, snapGuides.y, mode]);

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
      const state = getState(selectedIdx);
      setState(selectedIdx, { ...state, pan: { x: state.pan.x + dx, y: state.pan.y + dy } });
      emitSelectedState();
      redraw();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx]);

  // Export at target resolution + cell controls for panel
  useImperativeHandle(ref, () => ({
    // Cell index under a viewport point, or -1 (used for cross-page drops).
    hitTestClient(clientX, clientY) {
      const canvas = canvasRef.current;
      if (!canvas) return -1;
      const rect = canvas.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return -1;
      return hitTest(clientX - rect.left, clientY - rect.top);
    },
    setSelectedZoom(z) {
      if (selectedIdx < 0) return;
      setState(selectedIdx, { ...getState(selectedIdx), zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) });
      emitSelectedState();
      redraw();
    },
    centerSelected() {
      if (selectedIdx < 0) return;
      setState(selectedIdx, { ...getState(selectedIdx), pan: { x: 0, y: 0 } });
      emitSelectedState();
      redraw();
    },
    resetSelected() {
      if (selectedIdx < 0) return;
      setState(selectedIdx, DEFAULT_STATE());
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

      // Export wants the best source. If the HD image is still decoding, wait
      // for it (bounded) rather than silently exporting the thumbnail — or,
      // worse, an empty cell.
      const waitFor = (img, ms = 8000) => new Promise((resolve) => {
        if (isReady(img)) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        const done = () => { clearTimeout(timer); resolve(isReady(img)); };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
      await Promise.all(imgs.slice(0, cellRects.length).map(async (item) => {
        const best = getPreviewCandidates(item)[0];
        const img = best ? map.get(best) : null;
        if (img && !isReady(img)) await waitFor(img);
      }));

      for (let i = 0; i < cellRects.length; i++) {
        const rect = cellRects[i];
        const img = getLoadedImage(imgs[i]);
        const state = getState(i);
        if (img) {
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
            {t("replace")}
          </button>
          {onRemove && (
            <button
              type="button"
              className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-hover"
              onClick={() => {
                const idx = ctxMenu.cellIndex;
                setCtxMenu(null);
                onRemoveRef.current?.(idx);
              }}
            >
              {t("remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default CollageCanvas;
