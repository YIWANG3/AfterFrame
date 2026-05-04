import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { localFileUrl } from "../../utils/format";

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
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const cellAspect = w / h;
  let drawW, drawH;
  if (imgAspect > cellAspect) {
    drawH = h * zoom;
    drawW = drawH * imgAspect;
  } else {
    drawW = w * zoom;
    drawH = drawW / imgAspect;
  }
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

function computeCellRects(cells, canvasW, canvasH, gap, padding = 0) {
  const innerW = canvasW - padding * 2;
  const innerH = canvasH - padding * 2;
  return cells.map((cell) => {
    const rawX = cell.x * innerW + padding;
    const rawY = cell.y * innerH + padding;
    const rawW = cell.w * innerW;
    const rawH = cell.h * innerH;
    const halfGap = gap / 2;
    const isLeft = cell.x === 0;
    const isRight = Math.abs(cell.x + cell.w - 1) < 0.001;
    const isTop = cell.y === 0;
    const isBottom = Math.abs(cell.y + cell.h - 1) < 0.001;
    return {
      x: rawX + (isLeft ? 0 : halfGap),
      y: rawY + (isTop ? 0 : halfGap),
      w: rawW - (isLeft ? 0 : halfGap) - (isRight ? 0 : halfGap),
      h: rawH - (isTop ? 0 : halfGap) - (isBottom ? 0 : halfGap),
    };
  });
}

const CollageCanvas = forwardRef(function CollageCanvas(
  { images, template, canvasRatio, gap, padding, borderRadius, bgColor, exportWidth, className, onSwap, onReplace },
  ref,
) {
  const canvasRef = useRef(null);
  const loadedImgsRef = useRef(new Map());
  const cellStatesRef = useRef([]); // { pan: {x,y}, zoom }
  const rafRef = useRef(0);
  const dragRef = useRef(null);
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
  }, [template, images.length]);

  // Preview uses small thumbnails for speed; export uses full-res
  function getPreviewSrc(item) {
    if (!item) return null;
    return item.preview_hd_path || item.export_preview_hd_path || item.preview_path || item.export_preview_path || item.export_path;
  }

  function getExportSrc(item) {
    if (!item) return null;
    return item.export_path || item.export_preview_path || item.preview_path;
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

    // Scale params from export-space to display-space
    const scale = displayW / (ew || 3000);

    // Only resize backing store when dimensions actually change
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
  }

  function scheduleRedraw() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      redraw();
    });
  }

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

  // Pointer handlers — direct DOM, no React state during drag for performance
  // Store callbacks in refs so handler always sees latest
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
      if (idx < 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      const state = cellStatesRef.current[idx] || { pan: { x: 0, y: 0 }, zoom: 1 };
      dragRef.current = { idx, startX: e.clientX, startY: e.clientY, startPan: { x: state.pan.x, y: state.pan.y }, moved: false };
    }

    function onPointerMove(e) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      // Pan within the origin cell
      cellStatesRef.current[d.idx] = {
        ...cellStatesRef.current[d.idx],
        pan: { x: d.startPan.x + dx, y: d.startPan.y + dy },
      };
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
      if (!d.moved) return;
      // Check if released over a different cell → swap
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const targetIdx = hitTest(px, py);
      if (targetIdx >= 0 && targetIdx !== d.idx) {
        // Revert the pan we applied during drag
        cellStatesRef.current[d.idx] = {
          ...cellStatesRef.current[d.idx],
          pan: { x: d.startPan.x, y: d.startPan.y },
        };
        // Swap cell states too
        const tmp = cellStatesRef.current[d.idx];
        cellStatesRef.current[d.idx] = cellStatesRef.current[targetIdx] || { pan: { x: 0, y: 0 }, zoom: 1 };
        cellStatesRef.current[targetIdx] = tmp;
        onSwapRef.current?.(d.idx, targetIdx);
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = hitTest(px, py);
      if (idx < 0) return;
      const factor = e.deltaY > 0 ? 0.94 : 1.06;
      const state = cellStatesRef.current[idx] || { pan: { x: 0, y: 0 }, zoom: 1 };
      cellStatesRef.current[idx] = { ...state, zoom: Math.max(0.5, Math.min(5, state.zoom * factor)) };
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
  }, [template, gap, padding, exportWidth]); // re-bind when layout params change (for hitTest)

  // Export at target resolution
  useImperativeHandle(ref, () => ({
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

      // Params are in export-space, use directly at export resolution
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
  }), []);

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
            Replace
          </button>
        </div>
      )}
    </div>
  );
});

export default CollageCanvas;
