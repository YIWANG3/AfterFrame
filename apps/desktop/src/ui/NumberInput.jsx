import { useRef, useState } from "react";
import cx from "./cx";
import { FIELD_CHROME } from "./fields";

// The app's one numeric field. It replaced three: fields.jsx's NumberInput
// (Settings), Slider.jsx's NumberDragInput (the editor's scrub cells) and the
// filter bar's NumberBox (draft + commit on blur).
//
// Typing keeps a local draft, so "1." or an out-of-range number does not
// fight the controlled value: in-range numbers apply as they are typed, the
// rest waits for blur / Enter, which clamps to [min, max]. `onCommit(value)`
// fires once per gesture (blur after a change, scrub release) for history.
// `drag` makes the idle field a scrubber: drag left/right to change by `step`
// per pixel, click to type.
//
// Chrome and radius come from fields.jsx (FIELD_SIZE / FIELD_CHROME), the
// same as TextInput and Select, so a row of mixed fields matches. `size`
// "sm" (24 px, 11 px text) is the default; "md" (28 px) sits beside Settings'
// TextInput / Select.

const SIZE = {
  sm: "h-6 rounded-[6px] px-1.5 text-[11px]",
  md: "h-7 rounded-[8px] px-2 text-[12px]",
};
const CHROME = cx(FIELD_CHROME, "tabular-nums");
const DRAG_THRESHOLD = 3;

// The model can hold 17.999999 (layer sizes rescaled by float ratios), so
// show and scrub from a 2-decimal rounding unless the caller fixes `decimals`.
export function formatNumber(value, decimals) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return decimals != null ? n.toFixed(decimals) : String(Math.round(n * 100) / 100);
}

export default function NumberInput({
  value, min = -Infinity, max = Infinity, step = 1,
  onChange, onCommit,
  drag = false, decimals, prefix, suffix, placeholder,
  size = "sm", align = "right", className = "w-11", testId, ariaLabel,
  ...rest
}) {
  const ref = useRef(null);
  const [draft, setDraft] = useState(null); // the field's text while it is being edited
  const focusValueRef = useRef(null);
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const shown = draft ?? formatNumber(value, decimals);

  // Ends the edit: an empty or unparsable draft reverts, anything else is
  // clamped and applied. Returns the value the field ends on.
  const commit = (raw) => {
    setDraft(null);
    if (raw === "") return value;
    const n = Number(raw);
    if (!Number.isFinite(n)) return value;
    const next = clamp(n);
    if (next !== value) onChange?.(next);
    return next;
  };

  const handleMouseDown = (e) => {
    if (!drag || e.button !== 0) return;
    // Already focused: the caret is the user's, let the input handle it.
    if (document.activeElement === ref.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = Number(formatNumber(value, decimals)) || 0;
    let dragging = false;
    let last = startVal;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragging = true;
      // One px of drag = one step; keep the result on the step grid.
      const raw = startVal + Math.round(dx) * step;
      last = clamp(Math.round(raw / step) * step);
      onChange?.(last);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!dragging) ref.current?.focus(); // a click: type instead
      else onCommit?.(last);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const input = (
    <input
      ref={ref}
      type="number"
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      step={step}
      value={shown}
      placeholder={placeholder}
      data-testid={testId}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = Number(raw);
        // Apply as it is typed while the number is usable; "1." or 9999
        // over a cap of 2000 waits for the commit, which clamps.
        if (raw !== "" && Number.isFinite(n) && n >= min && n <= max && n !== value) onChange?.(n);
      }}
      onFocus={(e) => { focusValueRef.current = value; e.target.select(); }}
      onBlur={(e) => {
        const ended = commit(e.target.value);
        // Commit only when the value changed while focused — an idle
        // click-then-click-away must not burn an undo step.
        if (focusValueRef.current !== ended) onCommit?.(ended);
        focusValueRef.current = null;
      }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      onMouseDown={handleMouseDown}
      style={drag ? { cursor: "ew-resize" } : undefined}
      className={cx(
        prefix ? "min-w-0 flex-1 bg-transparent outline-none" : cx(SIZE[size], CHROME, className),
        align === "center" ? "text-center" : "text-right",
        drag && "focus:cursor-text",
      )}
      {...rest}
    />
  );

  if (!prefix && !suffix) return input;
  return (
    <div className="flex items-center gap-1.5">
      {prefix ? (
        <div className={cx("flex items-center gap-0.5", SIZE[size], CHROME, className)}>
          <span className="shrink-0 text-muted2">{prefix}</span>
          {input}
        </div>
      ) : input}
      {suffix && <span className="text-[10px] text-muted2">{suffix}</span>}
    </div>
  );
}
