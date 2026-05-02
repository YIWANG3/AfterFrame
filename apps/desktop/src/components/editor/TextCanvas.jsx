import { useRef, useCallback, useState } from "react";

const HANDLE_SIZE = 7;
const ROT_HANDLE_DIST = 28;
const ROT_HANDLE_RADIUS = 5;
const ACCENT = "rgb(210, 160, 90)";

export default function TextCanvas({
  layers,
  selectedIds,
  imageRect,
  onSelectionChange,
  onLayersChange,
  tool,
}) {
  const dragRef = useRef(null);
  const containerRef = useRef(null);
  const [editingId, setEditingId] = useState(null);

  const handleBgPointerDown = useCallback((e) => {
    if (e.target === e.currentTarget) {
      onSelectionChange(new Set());
      setEditingId(null);
    }
  }, [onSelectionChange]);

  const startDrag = useCallback((e, layerId, type) => {
    if (editingId === layerId) return; // don't drag while editing
    e.stopPropagation();
    e.preventDefault();
    const layer = layers.find((l) => l.id === layerId);
    if (!layer || !imageRect) return;

    if (!selectedIds.has(layerId)) {
      onSelectionChange(new Set([layerId]));
    }

    const startX = e.clientX;
    const startY = e.clientY;

    dragRef.current = {
      type,
      layerId,
      startX,
      startY,
      origX: layer.x,
      origY: layer.y,
      origRotation: layer.rotation,
      origFontSize: layer.fontSize,
    };

    const onMove = (me) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = me.clientX - drag.startX;
      const dy = me.clientY - drag.startY;

      if (drag.type === "move") {
        const nx = drag.origX + dx / imageRect.width;
        const ny = drag.origY + dy / imageRect.height;
        onLayersChange(layers.map((l) =>
          l.id === drag.layerId ? { ...l, x: nx, y: ny } : l
        ));
      } else if (drag.type === "rotate") {
        const cx = imageRect.x + layer.x * imageRect.width;
        const cy = imageRect.y + layer.y * imageRect.height;
        const startAngle = Math.atan2(drag.startY - cy, drag.startX - cx);
        const curAngle = Math.atan2(me.clientY - cy, me.clientX - cx);
        let deg = drag.origRotation + ((curAngle - startAngle) * 180) / Math.PI;
        for (const snap of [0, 90, 180, 270, -90, -180, -270]) {
          if (Math.abs(deg - snap) < 3) { deg = snap; break; }
        }
        onLayersChange(layers.map((l) =>
          l.id === drag.layerId ? { ...l, rotation: deg } : l
        ));
      } else if (drag.type === "resize") {
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sign = (dx + dy) > 0 ? 1 : -1;
        const sc = 1 + (sign * dist) / 200;
        const newSize = Math.round(Math.max(12, Math.min(400, drag.origFontSize * sc)));
        onLayersChange(layers.map((l) =>
          l.id === drag.layerId ? { ...l, fontSize: newSize } : l
        ));
      }
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [layers, selectedIds, imageRect, onSelectionChange, onLayersChange, editingId]);

  const handleDoubleClick = useCallback((layerId) => {
    setEditingId(layerId);
    onSelectionChange(new Set([layerId]));
  }, [onSelectionChange]);

  const handleEditInput = useCallback((layerId, newText) => {
    onLayersChange(layers.map((l) =>
      l.id === layerId ? { ...l, text: newText } : l
    ));
  }, [layers, onLayersChange]);

  const handleEditBlur = useCallback((layerId, newText) => {
    setEditingId(null);
    if (newText !== undefined) {
      onLayersChange(layers.map((l) =>
        l.id === layerId ? { ...l, text: newText } : l
      ));
    }
  }, [layers, onLayersChange]);

  if (tool !== "text" || !imageRect) return null;

  const scale = imageRect.width / 1920;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ zIndex: 15 }}
      onPointerDown={handleBgPointerDown}
    >
      {layers.map((layer) => {
        const fontSize = layer.fontSize * scale;
        const px = imageRect.x + layer.x * imageRect.width;
        const py = imageRect.y + layer.y * imageRect.height;
        const isSelected = selectedIds.has(layer.id);

        return (
          <TextLayerEl
            key={layer.id}
            layer={layer}
            fontSize={fontSize}
            scale={scale}
            px={px}
            py={py}
            isSelected={isSelected}
            isEditing={editingId === layer.id}
            onDragStart={(e, type) => startDrag(e, layer.id, type)}
            onDoubleClick={() => handleDoubleClick(layer.id)}
            onEditBlur={(text) => handleEditBlur(layer.id, text)}
            onEditInput={(id, text) => handleEditInput(id, text)}
            onSelect={(e) => {
              e.stopPropagation();
              if (e.shiftKey) {
                const next = new Set(selectedIds);
                next.has(layer.id) ? next.delete(layer.id) : next.add(layer.id);
                onSelectionChange(next);
              } else if (!selectedIds.has(layer.id)) {
                onSelectionChange(new Set([layer.id]));
              }
            }}
          />
        );
      })}
    </div>
  );
}

function TextLayerEl({ layer, fontSize, scale, px, py, isSelected, isEditing, onDragStart, onDoubleClick, onEditBlur, onEditInput, onSelect }) {
  const editRef = useRef(null);
  const fontStyle = layer.italic ? "italic" : "normal";
  const fontWeight = layer.fontWeight ?? (layer.bold ? 700 : 400);

  let color = hexToRgba(layer.fillColor, (layer.fillOpacity ?? 100) / 100);
  let backgroundImage = "none";
  let webkitBackgroundClip = "unset";
  let webkitTextFillColor = "unset";

  if (layer.fillMode === "gradient") {
    const angle = layer.gradientAngle;
    backgroundImage = `linear-gradient(${angle}deg, ${layer.gradientFrom}, ${layer.gradientTo})`;
    webkitBackgroundClip = "text";
    webkitTextFillColor = "transparent";
    color = "transparent";
  }

  const shadow = layer.shadow
    ? `${layer.shadowX * scale}px ${layer.shadowY * scale}px ${layer.shadowBlur * scale}px ${hexToRgba(layer.shadowColor, layer.shadowOpacity / 100)}`
    : "none";

  const strokeWidth = layer.strokeEnabled && layer.strokeWidth > 0
    ? layer.strokeWidth * scale : 0;

  const textStyle = {
    fontFamily: `"${layer.fontFamily}", sans-serif`,
    fontSize: `${fontSize}px`,
    fontStyle,
    fontWeight,
    color,
    backgroundImage,
    WebkitBackgroundClip: webkitBackgroundClip,
    WebkitTextFillColor: webkitTextFillColor,
    textShadow: shadow,
    opacity: layer.opacity / 100,
    whiteSpace: "nowrap",
    lineHeight: 1.2,
    textDecoration: layer.underline ? "underline" : "none",
    textDecorationColor: layer.fillMode === "gradient" ? layer.gradientFrom : undefined,
    paintOrder: strokeWidth > 0 ? "stroke fill" : undefined,
    WebkitTextStrokeWidth: strokeWidth > 0 ? `${strokeWidth * 2}px` : undefined,
    WebkitTextStrokeColor: strokeWidth > 0 ? layer.strokeColor : undefined,
  };

  return (
    <div
      style={{
        position: "absolute",
        left: `${px}px`,
        top: `${py}px`,
        transform: `translate(-50%, -50%) rotate(${layer.rotation || 0}deg)`,
        cursor: isEditing ? "text" : "move",
        userSelect: isEditing ? "text" : "none",
        zIndex: isSelected ? 2 : 1,
      }}
      onPointerDown={(e) => {
        if (isEditing) { e.stopPropagation(); return; }
        onSelect(e);
        onDragStart(e, "move");
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
    >
      {/* Background */}
      {layer.bgMode === "solid" && (
        <div
          style={{
            position: "absolute",
            inset: `-${fontSize * (layer.bgPadV ?? 15) / 100}px -${fontSize * (layer.bgPadH ?? 25) / 100}px`,
            backgroundColor: hexToRgba(layer.bgColor, layer.bgOpacity / 100),
            borderRadius: 0,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      {isEditing ? (
        <div
          ref={(el) => {
            editRef.current = el;
            if (el && !el.dataset.focused) {
              el.dataset.focused = "1";
              el.focus();
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }}
          contentEditable
          suppressContentEditableWarning
          style={{
            ...textStyle,
            outline: "none",
            minWidth: "1em",
            pointerEvents: "auto",
            caretColor: ACCENT,
            position: "relative",
            zIndex: 1,
          }}
          onInput={(e) => onEditInput(layer.id, e.currentTarget.textContent || "")}
          onBlur={(e) => onEditBlur(e.currentTarget.textContent || "")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onEditBlur(undefined);
            }
          }}
        >
          {layer.text || ""}
        </div>
      ) : (
        <div style={{ ...textStyle, pointerEvents: "none", position: "relative", zIndex: 1 }}>
          {layer.text || "\u00A0"}
        </div>
      )}

      {isSelected && !isEditing && (
        <SelectionOverlay onDragStart={onDragStart} />
      )}
    </div>
  );
}

function SelectionOverlay({ onDragStart }) {
  const pad = 8;
  // Map percentage positions to account for the pad offset so handles sit on the dashed border
  const mapPos = (pct) => {
    if (pct === "0%") return `-${pad}px`;
    if (pct === "50%") return `calc(50% - 0px)`;
    if (pct === "100%") return `calc(100% + ${pad}px)`;
    return pct;
  };
  const handleStyle = (x, y, cursor) => ({
    position: "absolute",
    left: `calc(${mapPos(x)} - ${HANDLE_SIZE / 2}px)`,
    top: `calc(${mapPos(y)} - ${HANDLE_SIZE / 2}px)`,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    backgroundColor: ACCENT,
    border: "1.5px solid #fff",
    cursor: `${cursor}-resize`,
    zIndex: 3,
  });

  return (
    <>
      <div style={{ position: "absolute", inset: `-${pad}px`, border: `1.5px dashed ${ACCENT}`, pointerEvents: "none" }} />
      {[
        ["0%", "0%", "nwse"], ["50%", "0%", "ns"], ["100%", "0%", "nesw"],
        ["0%", "50%", "ew"], ["100%", "50%", "ew"],
        ["0%", "100%", "nesw"], ["50%", "100%", "ns"], ["100%", "100%", "nwse"],
      ].map(([x, y, cursor], i) => (
        <div key={i} style={handleStyle(x, y, cursor)} onPointerDown={(e) => onDragStart(e, "resize")} />
      ))}
      <div style={{ position: "absolute", left: "50%", top: `-${pad}px`, width: 1.5, height: ROT_HANDLE_DIST, backgroundColor: ACCENT, opacity: 0.5, transform: "translate(-50%, -100%)", pointerEvents: "none" }} />
      <div
        style={{ position: "absolute", left: "50%", top: `-${pad + ROT_HANDLE_DIST}px`, width: ROT_HANDLE_RADIUS * 2, height: ROT_HANDLE_RADIUS * 2, borderRadius: "50%", backgroundColor: ACCENT, border: "1.5px solid #fff", transform: "translate(-50%, -50%)", cursor: "grab" }}
        onPointerDown={(e) => onDragStart(e, "rotate")}
      />
    </>
  );
}

function hexToRgba(hex, alpha = 1) {
  if (!hex || hex === "transparent") return `rgba(0,0,0,${alpha})`;
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}