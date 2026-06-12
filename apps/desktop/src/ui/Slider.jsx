import { useRef } from "react";
import cx from "./cx";

// Drag-to-scrub number input (click to type). Promoted from TextPanel where
// it lived as a private NumInput; StickerPanel had a static value box copy.
export function NumberDragInput({ value, min, max, onChange, className = "w-11" }) {
  const ref = useRef(null);
  const DRAG_THRESHOLD = 3;

  const handleMouseDown = (e) => {
    // If already focused (editing), let native input handle it
    if (document.activeElement === ref.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = value;
    let dragging = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragging = true;
      const next = Math.min(max, Math.max(min, startVal + Math.round(dx)));
      onChange(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!dragging) {
        // Was a click, not a drag — focus the input for typing
        ref.current?.focus();
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <input
      ref={ref}
      type="number" min={min} max={max} value={value}
      onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
      onFocus={(e) => e.target.select()}
      onMouseDown={handleMouseDown}
      style={{ cursor: "ew-resize" }}
      className={cx(
        "hide-spinner rounded-md border border-border/60 bg-app px-1.5 py-0.5 text-center text-[11px] text-text outline-none focus:border-[rgb(var(--accent-color))] focus:cursor-text",
        className,
      )}
    />
  );
}

// Label + range + scrubable value. The single SliderRow — TextPanel and
// StickerPanel previously each had their own.
export function SliderRow({ label, min, max, value, onChange, suffix, compact, className }) {
  return (
    <div className={cx("flex items-center gap-2", compact ? "" : "mt-2", className)}>
      {label && <label className="min-w-[48px] text-[10px] text-muted2">{label}</label>}
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider flex-1"
      />
      <NumberDragInput value={value} min={min} max={max} onChange={onChange} />
      {suffix && <span className="text-[10px] text-muted2">{suffix}</span>}
    </div>
  );
}
