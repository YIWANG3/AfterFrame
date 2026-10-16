import cx from "./cx";
import NumberInput, { formatNumber } from "./NumberInput";

// The app's one slider: a range with its label and value. Every tool panel
// used to draw its own (the text panel, the LUT strength, the crop zoom, the
// collage spacing fields, the filter bar's facet ranges); they all go
// through here now, so the track, thumb, label and value box match.
//
// `layout` "inline" puts label, range and value on one row (the editor's
// panels); "stacked" puts the label and value on a header row with the range
// full-width below (the collage panel). `valueMode` "input" shows the typed /
// scrubbed NumberInput, "text" a read-only figure, "none" nothing — a bare
// range for callers that frame the value themselves.
//
// `onCommit(value)` fires when a drag or key press on the range ends and when
// the number field commits — one history entry per gesture. `resetValue`
// snaps the value back on a double-click of the track. `inputMin` / `inputMax`
// let the typed value go past the range (the collage spacing field takes any
// whole number up to a cap; the slider covers the useful part).
export function SliderRow({
  label, min, max, step = 1, value, onChange, onCommit,
  suffix, prefix, decimals, format,
  layout = "inline", valueMode = "input", compact, className, resetValue,
  inputMin, inputMax, inputClassName, labelClassName,
  testId, inputTestId, ariaLabel,
}) {
  const rangeValue = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const commitRange = onCommit ? (e) => onCommit(Number(e.currentTarget.value)) : undefined;
  const range = (
    <input
      type="range" min={min} max={max} step={step} value={rangeValue}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={commitRange}
      onKeyUp={commitRange}
      // Opt-in: double-click the track to snap back to a default value.
      onDoubleClick={resetValue != null ? () => { onChange(resetValue); onCommit?.(resetValue); } : undefined}
      className={layout === "stacked" ? "mt-1 w-full" : "min-w-0 flex-1"}
      data-testid={testId}
      aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
    />
  );

  const stacked = layout === "stacked";
  const valueText = format ? format(value) : `${formatNumber(value, decimals)}${suffix ?? ""}`;
  const valueEl = valueMode === "input" ? (
    <>
      <NumberInput
        drag
        value={value}
        min={inputMin ?? min} max={inputMax ?? max} step={step}
        decimals={decimals} prefix={prefix}
        onChange={onChange} onCommit={onCommit}
        className={inputClassName ?? "w-11"}
        testId={inputTestId}
      />
      {suffix && <span className={cx(stacked ? "text-[11px]" : "text-[10px]", "text-muted2")}>{suffix}</span>}
    </>
  ) : valueMode === "text" ? (
    <span className={cx("tabular-nums", stacked ? "text-[11px] text-muted2" : "min-w-[36px] text-right text-[11px] text-text")}>{valueText}</span>
  ) : null;

  if (stacked) {
    return (
      <div className={className}>
        <div className="flex items-center justify-between">
          <label className={cx("text-[11px] text-muted", labelClassName)}>{label}</label>
          {valueEl && <div className="flex items-center gap-1">{valueEl}</div>}
        </div>
        {range}
      </div>
    );
  }
  return (
    <div className={cx("flex items-center gap-2", compact ? "" : "mt-2", className)}>
      {label && <label className={cx("text-[10px] text-muted2", labelClassName ?? "min-w-[48px]")}>{label}</label>}
      {range}
      {valueEl}
    </div>
  );
}
