// Interactive overlay for the Frame tool: draggable / resizable / rotatable
// selection boxes over the baked frame canvas, one per editable element.
// Rendered INSIDE the stage's zoom/pan transform, filling the same box as the
// canvas — so it scales with the canvas via CSS (no per-frame measuring) and
// its percentage-positioned boxes always line up. Move/resize/rotate write
// overrides (pos / scale / rotation) that the frame re-bakes from — just like
// a text layer.
//
// Snapping: while MOVING, the element's left/center/right (and top/center/
// bottom) edges snap to the other elements' edges + the canvas center, showing
// alignment guides — the smart-guide behavior of a design tool.

import { useRef, useState } from "react";
import SelectionHandles from "./SelectionHandles";
import { snapAngle, resizeRatio } from "../selectionMath";

const ACCENT = "rgb(210, 160, 90)";
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

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

export default function FrameEditOverlay({ layers, overrides, selectedElement, onSelect, onMove, onUpdate }) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [guides, setGuides] = useState({ x: null, y: null });
  if (!layers?.length) return null;

  // Screen center of an element + the overlay rect (zoom included).
  function centerOf(layer) {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r?.width) return null;
    return { r, cx: r.left + layer.x * r.width, cy: r.top + layer.y * r.height };
  }

  function beginMove(e, layer) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(layer.ei);
    const r = rootRef.current?.getBoundingClientRect();
    if (!r?.width || !r?.height) return;
    const halfW = (layer.box?.w || 0.1) / 2;
    const halfH = (layer.box?.h || 0.05) / 2;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layer.x, origY: layer.y, w: r.width, h: r.height };
    const threshX = 6 / r.width, threshY = 6 / r.height;
    const targetsX = [0.5], targetsY = [0.5];
    for (const l of layers) {
      if (l.ei === layer.ei) continue;
      const hw = (l.box?.w || 0) / 2, hh = (l.box?.h || 0) / 2;
      targetsX.push(l.x - hw, l.x, l.x + hw);
      targetsY.push(l.y - hh, l.y, l.y + hh);
    }
    listen((me) => {
      const d = dragRef.current;
      let nx = Math.max(0, Math.min(1, d.origX + (me.clientX - d.startX) / d.w));
      let ny = Math.max(0, Math.min(1, d.origY + (me.clientY - d.startY) / d.h));
      const sx = snapAxis(nx, halfW, targetsX, threshX);
      const sy = snapAxis(ny, halfH, targetsY, threshY);
      if (sx) nx = sx.center;
      if (sy) ny = sy.center;
      setGuides({ x: sx ? sx.line : null, y: sy ? sy.line : null });
      onMove(layer.ei, nx, ny);
    }, () => setGuides({ x: null, y: null }));
  }

  function beginResize(e, layer) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(layer.ei);
    const c = centerOf(layer);
    if (!c) return;
    const origScale = overrides?.[layer.ei]?.scale ?? 1;
    const center = { x: c.cx, y: c.cy };
    const start = { x: e.clientX, y: e.clientY };
    listen((me) => {
      const ratio = resizeRatio(center, start, { x: me.clientX, y: me.clientY });
      onUpdate(layer.ei, { scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, origScale * ratio)) });
    });
  }

  function beginRotate(e, layer) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(layer.ei);
    const c = centerOf(layer);
    if (!c) return;
    const origRot = layer.rotation || 0;
    const startAngle = Math.atan2(e.clientY - c.cy, e.clientX - c.cx);
    listen((me) => {
      const cur = Math.atan2(me.clientY - c.cy, me.clientX - c.cx);
      onUpdate(layer.ei, { rotation: snapAngle(origRot + ((cur - startAngle) * 180) / Math.PI) });
    });
  }

  // Shared pointer-capture loop.
  function listen(onMoveEvt, onEnd) {
    const up = () => {
      onEnd?.();
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", up);
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
            title="拖动移动 · 角柄缩放 · 顶柄旋转"
            onPointerDown={(e) => beginMove(e, l)}
            style={{
              position: "absolute",
              left: `${(l.x - w / 2) * 100}%`,
              top: `${(l.y - h / 2) * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
              cursor: "move",
              // When selected, SelectionHandles draws the box + handles — don't
              // draw our own border too (that was the double outline). Unselected
              // elements get a faint dashed hint that they're editable.
              border: selected ? "none" : "1.5px dashed rgba(210,160,90,0.45)",
              borderRadius: 2,
            }}
          >
            {selected && (
              <SelectionHandles
                onResizeStart={(e) => beginResize(e, l)}
                onRotateStart={(e) => beginRotate(e, l)}
              />
            )}
          </div>
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
