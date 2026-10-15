// The layer list: one row per layer, top of the stack first, dragged to
// reorder, with a delete button.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Type, GripVertical, Cannabis, Blend } from "lucide-react";
import { isStickerLayer, isOverlayLayer, layerLabel } from "../layerStack";

export default function LayerList({ layers, selectedIds, onSelect, onLayersChange, onDelete }) {
  const { t } = useTranslation("editor");
  const dragSrcIdRef = useRef(null);
  const [overInfo, setOverInfo] = useState(null); // { id, position: 'above'|'below' } in display order

  if (layers.length === 0) {
    return null;
  }

  // Display top-to-bottom = visual stack top-to-bottom (highest zIndex first).
  // The underlying array's last element is the topmost layer, so reverse for display.
  const display = [...layers].reverse();

  function startDrag(e, id) {
    dragSrcIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
    // Safety net: window-level cleanup in case dragend / drop is swallowed.
    const cleanup = () => {
      dragSrcIdRef.current = null;
      setOverInfo(null);
      window.removeEventListener("mouseup", cleanup);
      window.removeEventListener("dragend", cleanup);
      window.removeEventListener("drop", cleanup);
    };
    window.addEventListener("mouseup", cleanup);
    window.addEventListener("dragend", cleanup);
    window.addEventListener("drop", cleanup);
  }
  function onDragOver(e, id) {
    if (!dragSrcIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setOverInfo((prev) => (prev?.id === id && prev?.position === position ? prev : { id, position }));
  }
  function endDrag() {
    dragSrcIdRef.current = null;
    setOverInfo(null);
  }
  function onDrop(e, targetId) {
    e.preventDefault();
    const sourceId = dragSrcIdRef.current;
    setOverInfo(null);
    dragSrcIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;
    const sourceIdx = layers.findIndex((l) => l.id === sourceId);
    const targetIdx = layers.findIndex((l) => l.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = layers.slice();
    const [moved] = next.splice(sourceIdx, 1);
    const newTargetIdx = next.findIndex((l) => l.id === targetId);
    // In DISPLAY order (reversed), "above" target is visually above; in array, above-display = HIGHER array index.
    const insertIdx = overInfo?.position === "above" ? newTargetIdx + 1 : newTargetIdx;
    next.splice(insertIdx, 0, moved);
    onLayersChange(next);
  }

  return (
    <div className="flex flex-col gap-0.5">
      {display.map((l) => {
        const isSelected = selectedIds.has(l.id);
        const TypeIcon = isOverlayLayer(l) ? Blend : (isStickerLayer(l) ? Cannabis : Type);
        const showLineAbove = overInfo?.id === l.id && overInfo.position === "above";
        const showLineBelow = overInfo?.id === l.id && overInfo.position === "below";
        return (
          <div key={l.id} className="relative">
            {showLineAbove && <div className="pointer-events-none absolute left-2 right-2 top-0 h-0.5 bg-[rgb(var(--accent-color))]" />}
            <div
              data-layer-row={l.id}
              draggable={true}
              onDragStart={(e) => startDrag(e, l.id)}
              onDragEnd={endDrag}
              onDragOver={(e) => onDragOver(e, l.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setOverInfo((prev) => (prev?.id === l.id ? null : prev));
              }}
              onDrop={(e) => onDrop(e, l.id)}
              style={{ cursor: "grab" }}
              className={[
                "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors active:cursor-grabbing",
                isSelected ? "bg-[rgb(var(--accent-color)/0.06)]" : "hover:bg-hover",
              ].join(" ")}
              onClick={(e) => onSelect(l.id, e)}
            >
              <GripVertical className="h-3.5 w-3.5 flex-shrink-0 text-muted2" />
              <TypeIcon className={["h-3.5 w-3.5 flex-shrink-0", isSelected ? "text-[rgb(var(--accent-color))]" : "text-muted2"].join(" ")} />
              <span className={["flex-1 truncate text-[11px]", isSelected ? "text-text" : "text-muted"].join(" ")}>{layerLabel(l)}</span>
              <button
                type="button"
                draggable={false}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[rgb(var(--error-color)/0.15)] hover:text-[rgb(var(--error-color))]"
                title={t("text.deleteLayer")}
                onClick={(e) => { e.stopPropagation(); onDelete(l.id); }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {showLineBelow && <div className="pointer-events-none absolute left-2 right-2 bottom-0 h-0.5 bg-[rgb(var(--accent-color))]" />}
          </div>
        );
      })}
    </div>
  );
}
