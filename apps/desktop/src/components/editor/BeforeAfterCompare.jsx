import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Columns2, Rows2, X } from "lucide-react";
import { localFileUrl } from "../../utils/format";

function ToolbarBtn({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      className={[
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active ? "bg-white/12 text-white" : "text-white/40 hover:bg-white/8 hover:text-white/70",
      ].join(" ")}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Each cell renders its image with object-contain (browser handles aspect ratio),
 * then applies CSS transform for zoom & pan — no manual dimension math.
 */
function CompareCell({ src, label, zoom, pan, originPct, onWheel, onPointerDown, onPointerMove, onPointerUp }) {
  return (
    <div
      className="relative flex-1 overflow-hidden"
      style={{ cursor: "grab", touchAction: "none" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        src={src}
        alt={label}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{
          transformOrigin: `${originPct.x}% ${originPct.y}%`,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          willChange: "transform",
        }}
      />
      <div className="absolute left-3 top-3 rounded bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white/60 backdrop-blur-sm">
        {label}
      </div>
    </div>
  );
}

export default function BeforeAfterCompare({ beforePath, afterPath, layout, onClose, onLayoutChange }) {
  const { t } = useTranslation("editor");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [originPct, setOriginPct] = useState({ x: 50, y: 50 });
  const panStart = useRef(null);

  const horizontal = layout === "side";
  const beforeSrc = localFileUrl(beforePath);
  const afterSrc = localFileUrl(afterPath);

  // Reset on path/layout change
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOriginPct({ x: 50, y: 50 });
  }, [beforePath, afterPath, layout]);

  // Keyboard
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Zoom centered on mouse position within the cell
  const onWheel = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    setOriginPct({ x: px, y: py });
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setZoom((z) => Math.max(0.2, Math.min(20, z * factor)));
  }, []);

  // Synced pan
  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    panStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const onPointerMove = useCallback((e) => {
    if (!panStart.current) return;
    setPan({
      x: panStart.current.px + (e.clientX - panStart.current.x),
      y: panStart.current.py + (e.clientY - panStart.current.y),
    });
  }, []);

  const onPointerUp = useCallback((e) => {
    panStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const cellProps = { zoom, pan, originPct, onWheel, onPointerDown, onPointerMove, onPointerUp };

  return (
    <div className="fixed inset-0 z-[10200] flex flex-col bg-[rgb(8,8,8)]">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between bg-[rgb(14,14,14)] px-4">
        <div />
        <div className="flex items-center gap-1">
          <ToolbarBtn active={layout === "side"} icon={Columns2} label={t("compare.sideBySide")} onClick={() => onLayoutChange?.("side")} />
          <ToolbarBtn active={layout === "stack"} icon={Rows2} label={t("compare.topBottom")} onClick={() => onLayoutChange?.("stack")} />
          <div className="mx-1.5 h-4 w-px bg-white/8" />
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/8 hover:text-white/70"
            onClick={onClose}
            title={t("compare.close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Compare area */}
      <div className={`min-h-0 flex-1 flex ${horizontal ? "flex-row" : "flex-col"}`}>
        <CompareCell src={beforeSrc} label={t("compare.before")} {...cellProps} />
        <div className={`${horizontal ? "w-[2px]" : "h-[2px]"} shrink-0 bg-white/8`} />
        <CompareCell src={afterSrc} label={t("compare.after")} {...cellProps} />
      </div>

      {/* Footer */}
      <div className="flex h-8 shrink-0 items-center justify-center bg-[rgb(14,14,14)] text-[10px] text-white/30">
        {t("compare.hint")}
      </div>
    </div>
  );
}
