// Interactive overlay for the Frame tool: draggable selection boxes over the
// baked frame canvas, one per editable element. Positioned in percentages of
// `rect` (the on-screen box of the framed canvas), so it stays aligned at any
// fit-scale / zoom. Dragging writes an absolute position back (onMove), which
// the frame re-bakes from — the box you grab is the element you move, exactly
// like a text layer.

import { useRef } from "react";

const ACCENT = "rgb(210, 160, 90)";

export default function FrameEditOverlay({ rect, layers, selectedElement, onSelect, onMove }) {
  const dragRef = useRef(null);
  if (!rect || !layers?.length) return null;

  function beginDrag(e, layer) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(layer.ei);
    dragRef.current = { ei: layer.ei, startX: e.clientX, startY: e.clientY, origX: layer.x, origY: layer.y };

    const onMoveEvt = (me) => {
      const d = dragRef.current;
      if (!d || !rect.width || !rect.height) return;
      let nx = d.origX + (me.clientX - d.startX) / rect.width;
      let ny = d.origY + (me.clientY - d.startY) / rect.height;
      nx = Math.max(0, Math.min(1, nx));
      ny = Math.max(0, Math.min(1, ny));
      onMove(d.ei, nx, ny);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      className="absolute"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 20 }}
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
    </div>
  );
}
