// Interactive overlay for the Frame tool: draggable selection boxes over the
// baked frame canvas, one per editable element. Rendered INSIDE the stage's
// zoom/pan transform, filling the same box as the canvas — so it scales with
// the canvas via CSS (no per-frame measuring) and its percentage-positioned
// boxes always line up. Dragging writes an absolute position back (onMove),
// which the frame re-bakes from — the box you grab is the element you move,
// exactly like a text layer.
//
// Snapping: while dragging, the element's left/center/right (and top/center/
// bottom) edges snap to the other elements' edges + the canvas center, showing
// alignment guides — the smart-guide behavior of a design tool.

import { useRef, useState } from "react";

const ACCENT = "rgb(210, 160, 90)";

// Best snap for one axis: try the dragged element's [left, center, right]
// against each target line; return the adjusted center + the guide line.
function snapAxis(center, half, targets, thresh) {
  const cands = [
    { pos: center - half, adj: half },
    { pos: center, adj: 0 },
    { pos: center + half, adj: -half },
  ];
  let best = null;
  for (const c of cands) {
    for (const t of targets) {
      const dist = Math.abs(c.pos - t);
      if (dist < thresh && (!best || dist < best.dist)) best = { dist, center: t + c.adj, line: t };
    }
  }
  return best;
}

export default function FrameEditOverlay({ layers, selectedElement, onSelect, onMove }) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [guides, setGuides] = useState({ x: null, y: null });
  if (!layers?.length) return null;

  function beginDrag(e, layer) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(layer.ei);
    // On-screen size of the overlay (== canvas box, zoom included) — measured
    // once per drag so screen-px deltas map to fractions correctly at any zoom.
    const r = rootRef.current?.getBoundingClientRect();
    if (!r?.width || !r?.height) return;
    const halfW = (layer.box?.w || 0.1) / 2;
    const halfH = (layer.box?.h || 0.05) / 2;
    dragRef.current = { ei: layer.ei, startX: e.clientX, startY: e.clientY, origX: layer.x, origY: layer.y, halfW, halfH, w: r.width, h: r.height };
    const threshX = 6 / r.width;
    const threshY = 6 / r.height;
    const targetsX = [0.5];
    const targetsY = [0.5];
    for (const l of layers) {
      if (l.ei === layer.ei) continue;
      const hw = (l.box?.w || 0) / 2;
      const hh = (l.box?.h || 0) / 2;
      targetsX.push(l.x - hw, l.x, l.x + hw);
      targetsY.push(l.y - hh, l.y, l.y + hh);
    }

    const onMoveEvt = (me) => {
      const d = dragRef.current;
      if (!d) return;
      let nx = Math.max(0, Math.min(1, d.origX + (me.clientX - d.startX) / d.w));
      let ny = Math.max(0, Math.min(1, d.origY + (me.clientY - d.startY) / d.h));
      const sx = snapAxis(nx, d.halfW, targetsX, threshX);
      const sy = snapAxis(ny, d.halfH, targetsY, threshY);
      if (sx) nx = sx.center;
      if (sy) ny = sy.center;
      setGuides({ x: sx ? sx.line : null, y: sy ? sy.line : null });
      onMove(d.ei, nx, ny);
    };
    const onUp = () => {
      dragRef.current = null;
      setGuides({ x: null, y: null });
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0"
      style={{ zIndex: 20 }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
    >
      {layers.map((l) => {
        const selected = l.ei === selectedElement;
        const w = Math.max(0.03, l.box?.w || 0.1);
        const h = Math.max(0.02, l.box?.h || 0.05);
        return (
          <div
            key={l.ei}
            title="拖动调整位置"
            onPointerDown={(e) => beginDrag(e, l)}
            style={{
              position: "absolute",
              left: `${(l.x - w / 2) * 100}%`,
              top: `${(l.y - h / 2) * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
              cursor: "move",
              border: selected ? `1.5px solid ${ACCENT}` : "1.5px dashed rgba(210,160,90,0.5)",
              borderRadius: 2,
              background: selected ? "rgba(210,160,90,0.10)" : "transparent",
            }}
          />
        );
      })}
      {guides.x != null && (
        <div style={{ position: "absolute", left: `${guides.x * 100}%`, top: 0, width: 1, height: "100%", backgroundColor: ACCENT, opacity: 0.8, pointerEvents: "none" }} />
      )}
      {guides.y != null && (
        <div style={{ position: "absolute", left: 0, top: `${guides.y * 100}%`, width: "100%", height: 1, backgroundColor: ACCENT, opacity: 0.8, pointerEvents: "none" }} />
      )}
    </div>
  );
}
