// The statistics page's charts. Monochrome on purpose, like the rest of the
// app (accent = white, colour comes only from photos): every mark is the text
// colour at some opacity, so the light theme gets the same charts in ink.
// A colour palette for charts is a later decision.
//
// Each mark that stands for photos can be clicked (the page opens the
// gallery filtered to them) and shows its numbers on hover.

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx, Z } from "../../ui";

export const INK = (alpha) => `rgb(var(--text-color) / ${alpha})`;
const BAR = INK(0.42);
const BAR_HOVER = INK(0.85);
// The calendar's four steps above "no photos" (var(--fill)).
export const SHADES = ["var(--fill)", INK(0.2), INK(0.38), INK(0.6), INK(0.88)];

// ── hover tooltip ──────────────────────────────────────────────────────────
const TipContext = createContext(null);

export function TipProvider({ children }) {
  const [tip, setTip] = useState(null);
  const show = useCallback((event, title, detail) => setTip({ x: event.clientX, y: event.clientY, title, detail }), []);
  const hide = useCallback(() => setTip(null), []);
  return (
    <TipContext.Provider value={{ show, hide }}>
      {children}
      {tip && createPortal(
        <div
          data-testid="stats-tip"
          className="pointer-events-none fixed max-w-[260px] rounded-md border border-border/60 bg-chrome px-2.5 py-1.5 text-[11px] text-text shadow-overlay"
          style={{ left: Math.min(tip.x + 12, window.innerWidth - 270), top: tip.y + 14, zIndex: Z.popover }}
        >
          <div className="font-medium">{tip.title}</div>
          {tip.detail ? <div className="mt-0.5 text-muted2">{tip.detail}</div> : null}
        </div>,
        document.body,
      )}
    </TipContext.Provider>
  );
}

// Props that make an element show a tip and, when `onPick` is given, open
// what it stands for.
export function useTip() {
  const context = useContext(TipContext);
  return useCallback((title, detail, onPick) => ({
    onMouseEnter: (event) => context?.show(event, title, detail),
    onMouseMove: (event) => context?.show(event, title, detail),
    onMouseLeave: () => context?.hide(),
    onClick: onPick ? () => { context?.hide(); onPick(); } : undefined,
  }), [context]);
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// A bar whose top corners are rounded and whose foot stands on the baseline.
function barPath(x, y, w, h, r = 3) {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

// Vertical bars over categories. data: [{ key, label, value, title, detail, onPick }]
export function Columns({ data, height = 120, labelEvery = 1, testId }) {
  const [ref, width] = useWidth();
  const tip = useTip();
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const top = 6;
  const foot = 18;
  const slot = data.length ? width / data.length : 0;
  const barWidth = Math.max(2, Math.min(slot - 3, 30));
  return (
    <div ref={ref} data-testid={testId} className="w-full">
      {width > 0 && (
        <svg width={width} height={height + top + foot} className="block overflow-visible">
          <line x1={0} x2={width} y1={top + height / 2} y2={top + height / 2} stroke="var(--edge)" />
          <line x1={0} x2={width} y1={top + height + 0.5} y2={top + height + 0.5} stroke={INK(0.18)} />
          {data.map((d, i) => {
            const h = d.value ? Math.max(2, (d.value / max) * height) : 0;
            const x = i * slot + (slot - barWidth) / 2;
            const handlers = tip(d.title, d.detail, d.onPick);
            return (
              <g
                key={d.key ?? i}
                data-bar={d.key ?? d.label}
                className={d.onPick ? "cursor-pointer" : undefined}
                {...handlers}
                onMouseEnter={(e) => { setHover(i); handlers.onMouseEnter(e); }}
                onMouseLeave={() => { setHover(null); handlers.onMouseLeave(); }}
              >
                <rect x={i * slot} y={top} width={slot} height={height} fill="transparent" />
                {h > 0 && <path d={barPath(x, top + height - h, barWidth, h)} fill={hover === i ? BAR_HOVER : BAR} />}
                {(i % labelEvery === 0 || d.forceLabel) && (
                  <text x={i * slot + slot / 2} y={top + height + 13} textAnchor="middle" className="fill-muted2 text-[10px]">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// Horizontal bars, one row each: label, bar, value. rows: [{ key, label, value, valueLabel, title, detail, onPick }]
export function BarRows({ rows, labelWidth = 120, testId }) {
  const tip = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div data-testid={testId} className="flex flex-col">
      {rows.map((row) => (
        <div
          key={row.key ?? row.label}
          data-row={row.key ?? row.label}
          className={cx("group grid items-center gap-3 rounded py-[5px] text-[12px]", row.onPick && "cursor-pointer")}
          style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr) 64px` }}
          {...tip(row.title || row.label, row.detail, row.onPick)}
        >
          <span className="truncate text-muted group-hover:text-text">{row.label}</span>
          <Meter value={row.value / max} />
          <span className="text-right tabular-nums text-muted">{row.valueLabel ?? row.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// A thin track with a fill: a share of something.
export function Meter({ value, className }) {
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-[var(--fill)]", className)}>
      <div className="h-full rounded-full bg-text/40 transition-colors group-hover:bg-text/80" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

// One small bar per month: how a camera's use came and went.
export function Sparkline({ values, width = 132, height = 20 }) {
  const max = Math.max(1, ...values);
  const step = values.length ? width / values.length : 0;
  return (
    <svg width={width} height={height} className="block">
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * height) : 1;
        return <rect key={i} x={i * step} y={height - h} width={Math.max(1, step - 1.5)} height={h} rx={1} fill={v ? INK(0.55) : INK(0.12)} />;
      })}
    </svg>
  );
}

// Days of one year in Monday-first week columns (statsPage.calendarYear).
export function CalendarGrid({ year, shade, monthLabels, weekdayLabels, cellTitle, onPickDay }) {
  const tip = useTip();
  const cell = 11;
  const gap = 2;
  const left = 22;
  const top = 16;
  const months = [];
  for (const c of year.cells) {
    if (c.day.endsWith("-01")) months.push({ week: c.week, label: monthLabels[Number(c.day.slice(5, 7)) - 1] });
  }
  return (
    <div className="overflow-x-auto">
      <svg width={left + year.weeks * (cell + gap)} height={top + 7 * (cell + gap)} data-testid="stats-calendar" className="block">
        {months.map((m) => (
          <text key={m.label} x={left + m.week * (cell + gap)} y={10} className="fill-muted2 text-[10px]">{m.label}</text>
        ))}
        {[0, 2, 4].map((row) => (
          <text key={row} x={0} y={top + row * (cell + gap) + 9} className="fill-muted2 text-[10px]">{weekdayLabels[row]}</text>
        ))}
        {year.cells.map((c) => {
          const handlers = tip(cellTitle(c), null, c.count ? () => onPickDay(c) : undefined);
          return (
            <rect
              key={c.day}
              data-day={c.day}
              x={left + c.week * (cell + gap)}
              y={top + c.weekday * (cell + gap)}
              width={cell}
              height={cell}
              rx={2}
              fill={SHADES[shade(c.count)]}
              className={c.count ? "cursor-pointer hover:stroke-text" : undefined}
              {...handlers}
            />
          );
        })}
      </svg>
    </div>
  );
}
