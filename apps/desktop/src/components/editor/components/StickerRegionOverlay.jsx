import { useRef } from "react";

// Marquee overlay drawn on the editor canvas while the Sticker tool is active.
// User drags a rect; the parent (EditorOverlay) holds the committed region in
// state and feeds it back to the Sticker tool's Detect call to constrain
// VisionKit segmentation to a sub-rect of the source image.

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

export default function StickerRegionOverlay({ imageRect, region, drag, onDragChange, onCommit }) {
  const overlayRef = useRef(null);

  function clientToImageNorm(clientX, clientY) {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: clamp01(x), y: clamp01(y) };
  }

  function handlePointerDown(e) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const start = clientToImageNorm(e.clientX, e.clientY);
    onDragChange({ start, current: start });
  }
  function handlePointerMove(e) {
    if (!drag) return;
    const current = clientToImageNorm(e.clientX, e.clientY);
    onDragChange({ ...drag, current });
  }
  function handlePointerUp(e) {
    if (!drag) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const { start, current } = drag;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);
    onCommit({ x, y, w, h });
  }

  // What rect to draw — the active drag wins over a previously committed region.
  let active = null;
  if (drag) {
    const { start, current } = drag;
    active = {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      w: Math.abs(current.x - start.x),
      h: Math.abs(current.y - start.y),
    };
  } else if (region) {
    active = region;
  }

  return (
    <div
      ref={overlayRef}
      className="absolute"
      style={{
        left: `${imageRect.x}px`,
        top: `${imageRect.y}px`,
        width: `${imageRect.width}px`,
        height: `${imageRect.height}px`,
        zIndex: 9,
        cursor: "crosshair",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {active && active.w > 0.001 && active.h > 0.001 && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: `${active.y * 100}%`, backgroundColor: "rgba(0,0,0,0.4)" }} />
          <div className="pointer-events-none absolute inset-x-0" style={{ top: `${(active.y + active.h) * 100}%`, bottom: 0, backgroundColor: "rgba(0,0,0,0.4)" }} />
          <div className="pointer-events-none absolute" style={{ left: 0, width: `${active.x * 100}%`, top: `${active.y * 100}%`, height: `${active.h * 100}%`, backgroundColor: "rgba(0,0,0,0.4)" }} />
          <div className="pointer-events-none absolute" style={{ left: `${(active.x + active.w) * 100}%`, right: 0, top: `${active.y * 100}%`, height: `${active.h * 100}%`, backgroundColor: "rgba(0,0,0,0.4)" }} />
          <div
            className="pointer-events-none absolute"
            style={{
              left: `${active.x * 100}%`,
              top: `${active.y * 100}%`,
              width: `${active.w * 100}%`,
              height: `${active.h * 100}%`,
              border: "1.5px dashed rgb(var(--accent-color))",
            }}
          />
          {[
            [active.x, active.y],
            [active.x + active.w, active.y],
            [active.x, active.y + active.h],
            [active.x + active.w, active.y + active.h],
          ].map(([cx, cy], i) => (
            <div
              key={i}
              className="pointer-events-none absolute"
              style={{
                left: `calc(${cx * 100}% - 4px)`,
                top: `calc(${cy * 100}% - 4px)`,
                width: 8, height: 8,
                background: "rgb(var(--accent-color))",
                border: "1.5px solid #fff",
                borderRadius: 2,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
