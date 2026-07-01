import { useRef, useCallback, useState, memo, useEffect, useMemo } from "react";
import { getBgPadding } from "./textState";
import { stickerSrc } from "../../utils/format";
import SelectionHandles from "./components/SelectionHandles";
import { snapAngle, resizeRatio, snapAxis } from "./selectionMath";

// Half-width / half-height of a layer as fractions of the image rect — for
// element-to-element alignment snapping. Text is measured; stickers use scale.
let _measureCtx = null;
function layerHalfFrac(layer, imageRect) {
  if (!imageRect?.width) return { hw: 0, hh: 0 };
  const s = imageRect.width / 1920; // same display scale TextCanvas renders at
  if (layer.type === "sticker") {
    const aspect = layer.naturalHeight && layer.naturalWidth ? layer.naturalHeight / layer.naturalWidth : 1;
    const wPx = (layer.scale || 0.4) * imageRect.width;
    return { hw: (wPx / 2) / imageRect.width, hh: (wPx * aspect / 2) / imageRect.height };
  }
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  const fontPx = (layer.fontSize || 0) * s;
  const weight = layer.fontWeight ?? (layer.bold ? 700 : 400);
  _measureCtx.font = `${layer.italic ? "italic" : "normal"} ${weight} ${fontPx}px "${layer.fontFamily}", sans-serif`;
  const wPx = _measureCtx.measureText(layer.text || " ").width;
  return { hw: (wPx / 2) / imageRect.width, hh: (fontPx * 1.2 / 2) / imageRect.height };
}

/* Fully uncontrolled contentEditable — React.memo(() => true) prevents any
   re-render so React never touches the DOM text. Initial content is set via
   useEffect on mount; final text is read from the DOM on blur. */
const EditableDiv = memo(function EditableDiv({ initialText, style, onDone, onCancel }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initialText;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount only

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      style={style}
      onBlur={(e) => onDone(e.currentTarget.textContent || "")}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}, () => true);

const ACCENT = "rgb(210, 160, 90)";

export default function TextCanvas({
  layers,
  selectedIds,
  imageRect,
  onSelectionChange,
  onLayersChange,
  tool,
  depthFieldCanvas,
  depthFieldVersion,
  depthFeather = 0.08,
}) {
  const dragRef = useRef(null);
  const containerRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [guides, setGuides] = useState({ x: null, y: null }); // alignment guide-line fractions, or null

  const handleBgPointerDown = useCallback((e) => {
    if (e.target === e.currentTarget) {
      // Blur active contentEditable first so onBlur fires and saves the text
      if (document.activeElement?.contentEditable === "true") {
        document.activeElement.blur();
      }
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

    // Alignment targets: the OTHER layers' left/center/right (+ canvas 0/0.5/1),
    // computed once at drag start (they don't move during the drag).
    const half = layerHalfFrac(layer, imageRect);
    const targetsX = [0, 0.5, 1];
    const targetsY = [0, 0.5, 1];
    for (const l of layers) {
      if (l.id === layerId) continue;
      const h = layerHalfFrac(l, imageRect);
      targetsX.push(l.x - h.hw, l.x, l.x + h.hw);
      targetsY.push(l.y - h.hh, l.y, l.y + h.hh);
    }

    dragRef.current = {
      type,
      layerId,
      layerType: layer.type || "text",
      startX,
      startY,
      origX: layer.x,
      origY: layer.y,
      origRotation: layer.rotation,
      origFontSize: layer.fontSize,
      origScale: layer.scale,
      half, targetsX, targetsY,
    };

    const onMove = (me) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = me.clientX - drag.startX;
      const dy = me.clientY - drag.startY;

      if (drag.type === "move") {
        let nx = drag.origX + dx / imageRect.width;
        let ny = drag.origY + dy / imageRect.height;
        // Element-to-element (and canvas) alignment snapping: the dragged layer's
        // left/center/right edges snap to other layers' edges/centers.
        const sx = snapAxis(nx, drag.half.hw, drag.targetsX, 6 / imageRect.width);
        const sy = snapAxis(ny, drag.half.hh, drag.targetsY, 6 / imageRect.height);
        if (sx) nx = sx.center;
        if (sy) ny = sy.center;
        setGuides({ x: sx ? sx.line : null, y: sy ? sy.line : null });
        onLayersChange(layers.map((l) =>
          l.id === drag.layerId ? { ...l, x: nx, y: ny } : l
        ));
      } else if (drag.type === "rotate") {
        const cx = imageRect.x + layer.x * imageRect.width;
        const cy = imageRect.y + layer.y * imageRect.height;
        const startAngle = Math.atan2(drag.startY - cy, drag.startX - cx);
        const curAngle = Math.atan2(me.clientY - cy, me.clientX - cx);
        const deg = snapAngle(drag.origRotation + ((curAngle - startAngle) * 180) / Math.PI);
        onLayersChange(layers.map((l) =>
          l.id === drag.layerId ? { ...l, rotation: deg } : l
        ));
      } else if (drag.type === "resize") {
        // Use distance from layer center: pulling pointer AWAY from center
        // grows the layer (regardless of which handle was grabbed); pushing
        // toward center shrinks it.
        const cx = imageRect.x + layer.x * imageRect.width;
        const cy = imageRect.y + layer.y * imageRect.height;
        const ratio = resizeRatio({ x: cx, y: cy }, { x: drag.startX, y: drag.startY }, { x: me.clientX, y: me.clientY });

        if (drag.layerType === "sticker") {
          const newScale = Math.max(0.02, Math.min(2.0, drag.origScale * ratio));
          onLayersChange(layers.map((l) =>
            l.id === drag.layerId ? { ...l, scale: newScale } : l
          ));
        } else {
          const newSize = Math.round(Math.max(8, Math.min(2000, drag.origFontSize * ratio)));
          onLayersChange(layers.map((l) =>
            l.id === drag.layerId ? { ...l, fontSize: newSize } : l
          ));
        }
      }
    };

    const onUp = () => {
      dragRef.current = null;
      setGuides({ x: null, y: null });
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

  // Cache mask data URLs by zPosition; invalidates when depth field or feather changes.
  const maskCache = useMemo(() => new Map(), [depthFieldCanvas, depthFieldVersion, depthFeather]);
  const getMaskUrl = useCallback((zPosition) => {
    if (!depthFieldCanvas || zPosition == null || zPosition >= 1) return null;
    const key = zPosition.toFixed(3);
    if (maskCache.has(key)) return maskCache.get(key);
    const dW = depthFieldCanvas.width;
    const dH = depthFieldCanvas.height;
    const data = depthFieldCanvas.getContext("2d").getImageData(0, 0, dW, dH).data;
    const lo = Math.max(0, zPosition - depthFeather / 2);
    const hi = Math.min(1, zPosition + depthFeather / 2);
    const out = document.createElement("canvas");
    out.width = dW; out.height = dH;
    const oCtx = out.getContext("2d");
    const id = oCtx.createImageData(dW, dH);
    for (let i = 0; i < dW * dH; i++) {
      const d = data[i * 4] / 255;
      let a;
      if (d <= lo) a = 1;
      else if (d >= hi) a = 0;
      else a = 1 - (d - lo) / (hi - lo);
      const p = i * 4;
      id.data[p] = 255; id.data[p + 1] = 255; id.data[p + 2] = 255;
      id.data[p + 3] = Math.round(a * 255);
    }
    oCtx.putImageData(id, 0, 0);
    const url = out.toDataURL();
    maskCache.set(key, url);
    return url;
  }, [depthFieldCanvas, depthFieldVersion, depthFeather, maskCache]);

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
        // Image-relative coords inside the per-layer mask wrapper
        const px = layer.x * imageRect.width;
        const py = layer.y * imageRect.height;
        const isSelected = selectedIds.has(layer.id);
        const maskUrl = getMaskUrl(layer.zPosition);
        const wrapperStyle = {
          position: "absolute",
          left: `${imageRect.x}px`,
          top: `${imageRect.y}px`,
          width: `${imageRect.width}px`,
          height: `${imageRect.height}px`,
          overflow: "visible",
          // The wrapper covers the full image rect (so the depth mask aligns),
          // but it's transparent — without `none`, the topmost wrapper would
          // swallow clicks on text layers below it. Inner layer els re-enable
          // pointer events explicitly.
          pointerEvents: "none",
          ...(maskUrl
            ? {
                WebkitMaskImage: `url(${maskUrl})`,
                maskImage: `url(${maskUrl})`,
                WebkitMaskSize: "100% 100%",
                maskSize: "100% 100%",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
              }
            : {}),
        };

        const onSelect = (e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            const next = new Set(selectedIds);
            next.has(layer.id) ? next.delete(layer.id) : next.add(layer.id);
            onSelectionChange(next);
          } else if (!selectedIds.has(layer.id)) {
            onSelectionChange(new Set([layer.id]));
          }
        };

        return (
          <div key={layer.id} style={wrapperStyle}>
            {layer.type === "sticker" ? (
              <StickerLayerEl
                layer={layer}
                scale={scale}
                px={px}
                py={py}
                imageWidth={imageRect.width}
                isSelected={isSelected}
                onDragStart={(e, type) => startDrag(e, layer.id, type)}
                onSelect={onSelect}
              />
            ) : (
              <TextLayerEl
                layer={layer}
                fontSize={layer.fontSize * scale}
                scale={scale}
                px={px}
                py={py}
                isSelected={isSelected}
                isEditing={editingId === layer.id}
                onDragStart={(e, type) => startDrag(e, layer.id, type)}
                onDoubleClick={() => handleDoubleClick(layer.id)}
                onEditBlur={(text) => handleEditBlur(layer.id, text)}
                onEditInput={(id, text) => handleEditInput(id, text)}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
      {/* Alignment guide lines — at the snapped fraction (element edge/center or canvas). */}
      {guides.x != null && (
        <div style={{ position: "absolute", left: imageRect.x + imageRect.width * guides.x, top: imageRect.y, width: 1, height: imageRect.height, backgroundColor: ACCENT, opacity: 0.7, pointerEvents: "none" }} />
      )}
      {guides.y != null && (
        <div style={{ position: "absolute", left: imageRect.x, top: imageRect.y + imageRect.height * guides.y, width: imageRect.width, height: 1, backgroundColor: ACCENT, opacity: 0.7, pointerEvents: "none" }} />
      )}
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
    const fromAlpha = (layer.gradientFromOpacity ?? 100) / 100;
    const toAlpha = (layer.gradientToOpacity ?? 100) / 100;
    backgroundImage = `linear-gradient(${angle}deg, ${hexToRgba(layer.gradientFrom, fromAlpha)}, ${hexToRgba(layer.gradientTo, toAlpha)})`;
    webkitBackgroundClip = "text";
    webkitTextFillColor = "transparent";
    color = "transparent";
  }

  const shadowParts = layer.shadow
    ? `${layer.shadowX * scale}px ${layer.shadowY * scale}px ${layer.shadowBlur * scale}px ${hexToRgba(layer.shadowColor, layer.shadowOpacity / 100)}`
    : null;
  // CSS text-shadow paints UNDER the foreground glyph fill, but with
  // background-clip: text + transparent foreground (gradient fill) the shadow
  // can show through the transparent areas. drop-shadow operates on the actual
  // rendered output, so it always paints behind the gradient text.
  const useDropShadow = layer.fillMode === "gradient" && shadowParts;

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
    textShadow: !useDropShadow && shadowParts ? shadowParts : "none",
    filter: useDropShadow ? `drop-shadow(${shadowParts})` : undefined,
    opacity: layer.opacity / 100,
    whiteSpace: "nowrap",
    lineHeight: 1.2,
    textDecorationLine: layer.underline ? "underline" : "none",
    // Always set an explicit color: in gradient mode `color` becomes "transparent",
    // which would also make text-decoration invisible if it inherits from color.
    textDecorationColor: layer.underline
      ? (layer.fillMode === "gradient"
          ? (layer.gradientFrom || "#ffffff")
          : layer.fillColor)
      : undefined,
    textDecorationThickness: layer.underline ? `${Math.max(2, fontSize * 0.04)}px` : undefined,
    textUnderlineOffset: layer.underline ? `${Math.max(2, fontSize * 0.06)}px` : undefined,
    paintOrder: strokeWidth > 0 ? "stroke fill" : undefined,
    WebkitTextStrokeWidth: strokeWidth > 0 ? `${strokeWidth * 2}px` : undefined,
    // When stroke mode is gradient we render the actual stroke via an SVG overlay
    // (CSS -webkit-text-stroke doesn't support gradients). Set color to transparent
    // here so the HTML stroke doesn't paint over the SVG one.
    WebkitTextStrokeColor: strokeWidth > 0
      ? (layer.strokeMode === "gradient" ? "transparent" : layer.strokeColor)
      : undefined,
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
        // Re-enable pointer events; the parent wrapper sets pointerEvents: none
        // so clicks pass through transparent areas to layers below.
        pointerEvents: "auto",
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
      {(layer.bgMode === "solid" || layer.bgMode === "gradient") && (() => {
        const pad = getBgPadding(layer);
        const t = (fontSize * pad.top) / 100;
        const r = (fontSize * pad.right) / 100;
        const b = (fontSize * pad.bottom) / 100;
        const l = (fontSize * pad.left) / 100;
        const bgOp = (layer.bgOpacity ?? 100) / 100;
        const bgStyle = layer.bgMode === "gradient"
          ? {
              backgroundImage: `linear-gradient(${layer.bgGradAngle ?? 90}deg, ${hexToRgba(layer.bgGradFrom ?? layer.bgColor ?? "#000", ((layer.bgGradFromOpacity ?? 100) / 100) * bgOp)}, ${hexToRgba(layer.bgGradTo ?? "#fff", ((layer.bgGradToOpacity ?? 100) / 100) * bgOp)})`,
            }
          : {
              backgroundColor: hexToRgba(layer.bgColor, bgOp),
            };
        return (
          <div
            style={{
              position: "absolute",
              inset: `${-t}px ${-r}px ${-b}px ${-l}px`,
              ...bgStyle,
              borderRadius: 0,
              pointerEvents: "none",
              zIndex: 0,
            }}
          />
        );
      })()}

      {isEditing ? (
        <EditableDiv
          key={layer.id}
          initialText={layer.text || ""}
          style={{
            ...textStyle,
            outline: "none",
            minWidth: "1em",
            pointerEvents: "auto",
            caretColor: ACCENT,
            position: "relative",
            zIndex: 1,
          }}
          onDone={(text) => onEditBlur(text)}
          onCancel={() => onEditBlur(undefined)}
        />
      ) : (
        <div style={{ ...textStyle, pointerEvents: "none", position: "relative", zIndex: 1 }}>
          {layer.text || "\u00A0"}
        </div>
      )}

      {/* SVG stroke gradient overlay \u2014 CSS WebkitTextStroke doesn't support gradients,
          so when stroke mode is gradient we render an SVG <text> behind the HTML one
          with stroke="url(#grad)". The HTML text on top covers the inner half of the
          stroke (paint-order trick), giving an outer-only gradient stroke. */}
      {!isEditing && layer.strokeEnabled && layer.strokeMode === "gradient" && layer.strokeWidth > 0 && (
        <svg
          aria-hidden
          style={{
            position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
            overflow: "visible", pointerEvents: "none", zIndex: 0,
          }}
        >
          <defs>
            <linearGradient
              id={`stroke-grad-${layer.id}`}
              gradientUnits="objectBoundingBox"
              gradientTransform={`rotate(${(layer.strokeGradAngle ?? 90) - 90} 0.5 0.5)`}
            >
              <stop offset="0" stopColor={layer.strokeGradFrom || layer.strokeColor} stopOpacity={(layer.strokeGradFromOpacity ?? 100) / 100} />
              <stop offset="1" stopColor={layer.strokeGradTo || "#000000"} stopOpacity={(layer.strokeGradToOpacity ?? 100) / 100} />
            </linearGradient>
          </defs>
          <text
            x="50%" y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily={`"${layer.fontFamily}", sans-serif`}
            fontSize={fontSize}
            fontWeight={fontWeight}
            fontStyle={fontStyle}
            stroke={`url(#stroke-grad-${layer.id})`}
            strokeWidth={layer.strokeWidth * scale * 2}
            strokeLinejoin="round"
            fill="transparent"
            paintOrder="stroke"
          >{layer.text || ""}</text>
        </svg>
      )}

      {isSelected && !isEditing && (
        <SelectionHandles onResizeStart={(e) => onDragStart(e, "resize")} onRotateStart={(e) => onDragStart(e, "rotate")} />
      )}
    </div>
  );
}

function StickerLayerEl({ layer, scale, px, py, imageWidth, isSelected, onDragStart, onSelect }) {
  // `scale` (the global preview/export scale) is *not* used to size the
  // sticker — sticker size is `layer.scale * imageWidth`, then scaled to the
  // current preview by virtue of being inside the imageRect-sized wrapper.
  const widthPx = (layer.scale || 0.4) * imageWidth;
  const aspect = layer.naturalHeight && layer.naturalWidth
    ? layer.naturalHeight / layer.naturalWidth
    : 1;
  const heightPx = widthPx * aspect;

  // Shadow as drop-shadow (works on the alpha PNG)
  const shadow = layer.shadow
    ? `drop-shadow(${layer.shadowX * scale}px ${layer.shadowY * scale}px ${layer.shadowBlur * scale}px ${hexToRgba(layer.shadowColor, layer.shadowOpacity / 100)})`
    : undefined;

  // Runtime outline via SVG feMorphology — dilate alpha → flood color → composite under the source.
  // outlineWidth is in image-px (matches sticker scale) so it grows with zoom.
  const outlineWidth = layer.outlineWidth || 0;
  const hasOutline = outlineWidth > 0;
  const filterId = `sticker-outline-${layer.id}`;

  return (
    <div
      style={{
        position: "absolute",
        left: `${px}px`,
        top: `${py}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        transform: `translate(-50%, -50%) rotate(${layer.rotation || 0}deg)`,
        cursor: "move",
        userSelect: "none",
        zIndex: isSelected ? 2 : 1,
        opacity: layer.opacity / 100,
        filter: shadow,
        pointerEvents: "auto",
      }}
      onPointerDown={(e) => {
        onSelect(e);
        onDragStart(e, "move");
      }}
    >
      {hasOutline ? (
        <svg
          viewBox={`0 0 ${Math.max(1, layer.naturalWidth || widthPx)} ${Math.max(1, layer.naturalHeight || heightPx)}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-full w-full"
          style={{ overflow: "visible", pointerEvents: "none" }}
        >
          <defs>
            <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
              <feMorphology in="SourceAlpha" operator="dilate" radius={outlineWidth} result="dilated" />
              <feFlood floodColor={layer.outlineColor || "#ffffff"} result="floodColor" />
              <feComposite in="floodColor" in2="dilated" operator="in" result="outline" />
              <feMerge>
                <feMergeNode in="outline" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <image
            href={stickerSrc(layer.stickerPath)}
            x="0" y="0"
            width={Math.max(1, layer.naturalWidth || widthPx)}
            height={Math.max(1, layer.naturalHeight || heightPx)}
            preserveAspectRatio="xMidYMid meet"
            filter={`url(#${filterId})`}
          />
        </svg>
      ) : (
        <img
          src={stickerSrc(layer.stickerPath)}
          alt=""
          draggable={false}
          className="block h-full w-full select-none"
          style={{ objectFit: "contain", pointerEvents: "none" }}
        />
      )}
      {isSelected && <SelectionHandles onResizeStart={(e) => onDragStart(e, "resize")} onRotateStart={(e) => onDragStart(e, "rotate")} />}
    </div>
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