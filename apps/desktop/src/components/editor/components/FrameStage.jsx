// Frame preview surface — shown in the editor viewport while the frame tool is
// active. Hosts the engine-rendered framed canvas, scaled to fit, with
// scroll-to-zoom + drag-to-pan (double-click to reset). It covers the normal
// crop/layer editing surface (the frame expands the canvas, so it does NOT
// reuse the crop placement geometry).

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import FrameEditOverlay from "./FrameEditOverlay";

const MAX_ZOOM = 8;
const MIN_ZOOM = 0.25;

export default function FrameStage({ canvas, rendering, rightInset = 0, layers, selectedElement, onSelectElement, onMoveElement }) {
  const hostRef = useRef(null);
  const outerRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [canvasRect, setCanvasRect] = useState(null); // on-screen box of the canvas, relative to the stage — for the edit overlay

  // Keep the edit overlay glued to the displayed canvas across fit / zoom / pan
  // / resize by measuring the canvas rect relative to the stage container.
  useEffect(() => {
    function measure() {
      const outer = outerRef.current;
      const cv = hostRef.current?.firstChild;
      if (!outer || !cv?.getBoundingClientRect) { setCanvasRect(null); return; }
      const o = outer.getBoundingClientRect();
      const c = cv.getBoundingClientRect();
      setCanvasRect({ x: c.left - o.left, y: c.top - o.top, width: c.width, height: c.height });
    }
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && outerRef.current) ro.observe(outerRef.current);
    return () => ro?.disconnect();
  }, [canvas, zoom, pan]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (canvas) {
      canvas.style.maxWidth = "100%";
      canvas.style.maxHeight = "100%";
      canvas.style.boxShadow = "none";
      host.appendChild(canvas);
    }
  }, [canvas]);

  function reset() { setZoom(1); setPan({ x: 0, y: 0 }); }

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next <= 1) setPan({ x: 0, y: 0 }); // pan only matters when zoomed in
      return next;
    });
  }

  function onPointerDown(e) {
    if (zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }
  function onPointerUp(e) {
    dragRef.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  return (
    <div
      ref={outerRef}
      className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-app p-6"
      style={{ paddingRight: rightInset || undefined }}
      onWheel={onWheel}
      onDoubleClick={reset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        ref={hostRef}
        className="flex h-full w-full items-center justify-center"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
        }}
      />
      {canvas && onMoveElement && (
        <FrameEditOverlay
          rect={canvasRect}
          layers={layers}
          selectedElement={selectedElement}
          onSelect={onSelectElement}
          onMove={onMoveElement}
        />
      )}
      {!canvas && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-muted2" />
        </div>
      )}
      {Math.abs(zoom - 1) > 0.001 && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-chrome/90 px-3 py-1 text-[11px] text-muted shadow-overlay">
          {Math.round(zoom * 100)}% · 双击复位
        </div>
      )}
    </div>
  );
}
