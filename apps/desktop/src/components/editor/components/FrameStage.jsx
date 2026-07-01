// Frame preview surface — shown in the editor viewport while the frame tool is
// active. Hosts the engine-rendered framed canvas, scaled to fit, with
// scroll-to-zoom + drag-to-pan (double-click to reset). It covers the normal
// crop/layer editing surface (the frame expands the canvas, so it does NOT
// reuse the crop placement geometry).
//
// The canvas and the edit overlay share ONE fit-sized box inside the zoom/pan
// transform, so zooming is a pure CSS transform (smooth, no per-frame measuring)
// and the overlay's percentage-positioned boxes always line up with the canvas.

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import FrameEditOverlay from "./FrameEditOverlay";

const MAX_ZOOM = 8;
const MIN_ZOOM = 0.25;
const PAD = 24;

export default function FrameStage({ canvas, rendering, rightInset = 0, layers, selectedElement, onSelectElement, onMoveElement }) {
  const outerRef = useRef(null);
  const canvasHostRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Container size drives the fit — only changes on real resize, NOT on zoom.
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer || typeof ResizeObserver === "undefined") return undefined;
    const update = () => {
      const r = outer.getBoundingClientRect();
      setContainerSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(outer);
    return () => ro.disconnect();
  }, []);

  // Append the canvas; it fills the fit-sized box.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (canvas) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
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
      if (next <= 1) setPan({ x: 0, y: 0 });
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

  // Fit the canvas into the available (padded) area — unzoomed display size.
  const availW = Math.max(1, containerSize.w - PAD - (rightInset || PAD));
  const availH = Math.max(1, containerSize.h - PAD * 2);
  let dispW = 0, dispH = 0;
  if (canvas?.width && canvas?.height) {
    const fit = Math.min(availW / canvas.width, availH / canvas.height);
    dispW = canvas.width * fit;
    dispH = canvas.height * fit;
  }

  return (
    <div
      ref={outerRef}
      className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-app"
      style={{ padding: PAD, paddingRight: rightInset || PAD }}
      onWheel={onWheel}
      onDoubleClick={reset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
        }}
      >
        <div style={{ position: "relative", width: dispW, height: dispH }}>
          <div ref={canvasHostRef} style={{ width: "100%", height: "100%" }} />
          {canvas && onMoveElement && (
            <FrameEditOverlay
              layers={layers}
              selectedElement={selectedElement}
              onSelect={onSelectElement}
              onMove={onMoveElement}
            />
          )}
        </div>
      </div>
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
