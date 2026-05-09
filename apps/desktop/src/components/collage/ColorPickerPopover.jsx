import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

// ── Color math ────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v };
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function hexToHsv(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

function hsvToHex(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

// ── SB Area ───────────────────────────────────────────────

function SatBrightArea({ hue, sat, val, onChange }) {
  const ref = useRef(null);

  const update = useCallback((e) => {
    const rect = ref.current.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    onChange(s, v);
  }, [onChange]);

  function onDown(e) {
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    update(e);
  }

  function onMove(e) {
    if (!ref.current.hasPointerCapture(e.pointerId)) return;
    update(e);
  }

  return (
    <div
      ref={ref}
      className="relative cursor-crosshair rounded"
      style={{
        width: 208,
        height: 200,
        backgroundColor: `hsl(${hue}, 100%, 50%)`,
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
    >
      {/* Saturation: white → transparent */}
      <div className="absolute inset-0 rounded" style={{ background: "linear-gradient(to right, #fff, transparent)" }} />
      {/* Brightness: transparent → black */}
      <div className="absolute inset-0 rounded" style={{ background: "linear-gradient(to bottom, transparent, #000)" }} />
      {/* Handle */}
      <div
        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
        style={{
          left: `${sat * 100}%`,
          top: `${(1 - val) * 100}%`,
          boxShadow: "0 0 2px rgba(0,0,0,0.6)",
        }}
      />
    </div>
  );
}

// ── Hue Slider ────────────────────────────────────────────

function HueSlider({ hue, onChange }) {
  const ref = useRef(null);

  const update = useCallback((e) => {
    const rect = ref.current.getBoundingClientRect();
    const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
    onChange(h);
  }, [onChange]);

  function onDown(e) {
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    update(e);
  }

  function onMove(e) {
    if (!ref.current.hasPointerCapture(e.pointerId)) return;
    update(e);
  }

  return (
    <div
      ref={ref}
      className="relative cursor-pointer rounded-full"
      style={{
        width: 208,
        height: 12,
        background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
    >
      <div
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
        style={{
          left: `${(hue / 360) * 100}%`,
          boxShadow: "0 0 2px rgba(0,0,0,0.6)",
        }}
      />
    </div>
  );
}

// ── Main Popover ──────────────────────────────────────────

// ── Opacity Slider ───────────────────────────────────────

function OpacitySlider({ hue, sat, val, opacity, onChange }) {
  const ref = useRef(null);

  const update = useCallback((e) => {
    const rect = ref.current.getBoundingClientRect();
    const a = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onChange(Math.round(a * 100) / 100);
  }, [onChange]);

  function onDown(e) {
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    update(e);
  }

  function onMove(e) {
    if (!ref.current.hasPointerCapture(e.pointerId)) return;
    update(e);
  }

  const { r, g, b } = hsvToRgb(hue, sat, val);

  return (
    <div
      ref={ref}
      className="relative cursor-pointer rounded-full"
      style={{
        width: 208,
        height: 12,
        background: `linear-gradient(to right, rgba(${r},${g},${b},0), rgba(${r},${g},${b},1)), repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px`,
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
    >
      <div
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
        style={{
          left: `${opacity * 100}%`,
          boxShadow: "0 0 2px rgba(0,0,0,0.6)",
        }}
      />
    </div>
  );
}

export default function ColorPickerPopover({
  color, onChange, onClose, anchorEl,
  opacity: opacityProp, onOpacityChange, presets,
  // Gradient-paint extension. When availableModes includes "gradient",
  // the picker shows mode tabs at the top. When mode === "gradient",
  // the picker shows a stops bar + angle controls and edits the active stop.
  availableModes,
  mode = "solid",
  onModeChange,
  gradient,
  onGradientChange,
}) {
  const popoverRef = useRef(null);
  const hueRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [activeStop, setActiveStop] = useState(0); // 0 = from, 1 = to
  const isGradient = mode === "gradient";
  const showTabs = Array.isArray(availableModes) && availableModes.length > 1;

  // What color/opacity the SV-square + hue + hex currently edit.
  // - solid mode: the prop color/opacity
  // - gradient mode: the active stop's color/opacity
  const effectiveColor = isGradient && gradient
    ? (activeStop === 0 ? (gradient.from || "#000000") : (gradient.to || "#000000"))
    : (color || "#000000");
  const effectiveOpacity = isGradient && gradient
    ? (activeStop === 0 ? (gradient.fromOpacity ?? 1) : (gradient.toOpacity ?? 1))
    : (opacityProp ?? 1);

  // Init HSV from effective color
  const initial = hexToHsv(effectiveColor);
  if (initial.s > 0.01 || initial.v > 0.01) hueRef.current = initial.h;

  const [hsv, setHsv] = useState({ h: hueRef.current, s: initial.s, v: initial.v });
  const [hexDraft, setHexDraft] = useState(effectiveColor.replace("#", "").toUpperCase());
  const [localOpacity, setLocalOpacity] = useState(effectiveOpacity);
  const [pos, setPos] = useState(null);

  const opacity = effectiveOpacity != null ? effectiveOpacity : localOpacity;

  function emitColorChange(hex) {
    if (isGradient && onGradientChange) {
      onGradientChange(activeStop === 0 ? { from: hex } : { to: hex });
    } else if (onChange) {
      onChange(hex);
    }
  }
  function emitOpacityChange(op) {
    if (isGradient && onGradientChange) {
      onGradientChange(activeStop === 0 ? { fromOpacity: op } : { toOpacity: op });
    } else if (onOpacityChange) {
      onOpacityChange(op);
    } else {
      setLocalOpacity(op);
    }
  }
  const setOpacity = emitOpacityChange;

  // When the externally-driven effective color changes (mode flip, stop switch,
  // parent updated the value), re-sync the internal HSV so the SV square reflects it.
  useEffect(() => {
    const next = hexToHsv(effectiveColor);
    if (next.s > 0.01 || next.v > 0.01) hueRef.current = next.h;
    setHsv({ h: hueRef.current, s: next.s, v: next.v });
    setHexDraft(effectiveColor.replace("#", "").toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveColor]);

  // Position near anchor — try left of, then right of, then above, then below.
  // Pick the first candidate that fits entirely in the viewport. Fall back to
  // clamping if none fit (very small viewport).
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const popW = 240;
    const popH = isGradient ? 400 : 310;
    const m = 8; // viewport margin
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerY = rect.top + rect.height / 2 - popH / 2;
    const centerX = rect.left + rect.width / 2 - popW / 2;
    // Preference order: above the anchor (away from inspector below), then
    // left of anchor (into the canvas area), then below, then right.
    const candidates = [
      { left: centerX,                top: rect.top - popH - m }, // above
      { left: rect.left - popW - m,  top: centerY },             // left of anchor
      { left: centerX,                top: rect.bottom + m },     // below
      { left: rect.right + m,         top: centerY },             // right of anchor
    ];
    const fits = (c) =>
      c.left >= m && c.left + popW <= vw - m &&
      c.top >= m && c.top + popH <= vh - m;
    let chosen = candidates.find(fits);
    if (!chosen) {
      // Clamp the "left of anchor" candidate as fallback
      const c = candidates[0];
      chosen = {
        left: Math.max(m, Math.min(vw - popW - m, c.left)),
        top: Math.max(m, Math.min(vh - popH - m, c.top)),
      };
    }
    setPos(chosen);
  }, [anchorEl, isGradient]);

  // Click outside — delay registration by one frame to avoid catching the opening click
  useEffect(() => {
    let id;
    function handle(e) {
      if (popoverRef.current?.contains(e.target)) return;
      if (anchorEl?.contains(e.target)) return;
      onCloseRef.current();
    }
    function handleKey(e) {
      if (e.key === "Escape") onCloseRef.current();
    }
    id = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", handle);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [anchorEl]);

  function onSBChange(s, v) {
    setHsv((prev) => {
      if (s > 0.01 || v > 0.01) hueRef.current = prev.h;
      return { h: prev.h, s, v };
    });
    const hex = hsvToHex(hueRef.current, s, v);
    setHexDraft(hex.replace("#", "").toUpperCase());
    emitColorChange(hex);
  }

  function onHueChange(h) {
    hueRef.current = h;
    setHsv((prev) => ({ ...prev, h }));
    const hex = hsvToHex(h, hsv.s, hsv.v);
    setHexDraft(hex.replace("#", "").toUpperCase());
    emitColorChange(hex);
  }

  function onHexCommit() {
    const cleaned = hexDraft.replace("#", "").trim();
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      const parsed = hexToHsv(`#${cleaned}`);
      if (parsed.s > 0.01 || parsed.v > 0.01) hueRef.current = parsed.h;
      setHsv({ h: hueRef.current, s: parsed.s, v: parsed.v });
      emitColorChange(`#${cleaned.toLowerCase()}`);
    } else {
      // Revert to current
      setHexDraft(hsvToHex(hsv.h, hsv.s, hsv.v).replace("#", "").toUpperCase());
    }
  }

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const { r: cr, g: cg, b: cb } = hsvToRgb(hsv.h, hsv.s, hsv.v);

  const pickFromScreen = useCallback(async () => {
    try {
      if (!window.EyeDropper) return;
      const dropper = new window.EyeDropper();
      const result = await dropper.open();
      if (result?.sRGBHex) {
        const parsed = hexToHsv(result.sRGBHex);
        if (parsed.s > 0.01 || parsed.v > 0.01) hueRef.current = parsed.h;
        setHsv({ h: hueRef.current, s: parsed.s, v: parsed.v });
        emitColorChange(result.sRGBHex);
      }
    } catch { /* user cancelled */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGradient, activeStop]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[10300] rounded-lg border border-border bg-panel p-3 shadow-overlay"
      style={{ top: pos.top, left: pos.left, width: 240 }}
    >
      <div className="space-y-3">
        {showTabs && (
          <div className="flex gap-1 rounded-md bg-app p-0.5">
            {availableModes.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange?.(m)}
                className={[
                  "flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  mode === m
                    ? "bg-panel text-text shadow-sm"
                    : "text-muted2 hover:text-text",
                ].join(" ")}
              >
                {m === "solid" ? "Solid" : m === "gradient" ? "Linear" : m}
              </button>
            ))}
          </div>
        )}

        {isGradient && gradient && (
          <>
            <div className="flex items-center gap-2">
              <GradientStopsBar
                gradient={gradient}
                activeStop={activeStop}
                onSelectStop={setActiveStop}
              />
              <button
                type="button"
                title="Reverse stops"
                onClick={() => onGradientChange?.({
                  from: gradient.to,
                  fromOpacity: gradient.toOpacity,
                  to: gradient.from,
                  toOpacity: gradient.fromOpacity,
                })}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-border/60 bg-app text-muted hover:bg-hover hover:text-text"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={Math.round(gradient.angle ?? 0)}
                onChange={(e) => onGradientChange?.({ angle: Number(e.target.value) })}
                className="flex-1 accent-[rgb(var(--accent-color))]"
              />
              <input
                type="number"
                value={Math.round(gradient.angle ?? 0)}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) onGradientChange?.({ angle: ((v % 360) + 360) % 360 });
                }}
                className="hide-spinner w-12 h-6 rounded border border-border/60 bg-app px-1.5 text-center text-[11px] text-text outline-none"
              />
            </div>
          </>
        )}

        <SatBrightArea hue={hsv.h} sat={hsv.s} val={hsv.v} onChange={onSBChange} />
        <HueSlider hue={hsv.h} onChange={onHueChange} />
        <OpacitySlider hue={hsv.h} sat={hsv.s} val={hsv.v} opacity={opacity} onChange={setOpacity} />

        {/* Hex + Opacity input row */}
        <div className="flex items-center gap-1.5">
          {/* Preview swatch with checkerboard behind for transparency */}
          <div
            className="h-6 w-6 shrink-0 rounded border border-border"
            style={{
              background: `linear-gradient(rgba(${cr},${cg},${cb},${opacity}), rgba(${cr},${cg},${cb},${opacity})), repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px`,
            }}
          />
          <div className="flex h-6 flex-1 items-center rounded border border-border/60 bg-app px-2">
            <span className="text-[11px] text-muted2">#</span>
            <input
              type="text"
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value.toUpperCase())}
              onBlur={onHexCommit}
              onKeyDown={(e) => { if (e.key === "Enter") onHexCommit(); }}
              maxLength={6}
              className="ml-0.5 w-full bg-transparent text-[11px] text-text outline-none"
              spellCheck={false}
            />
          </div>
          <div className="flex h-6 w-[52px] items-center rounded border border-border/60 bg-app px-1.5">
            <input
              type="text"
              value={`${Math.round(opacity * 100)}`}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) setOpacity(Math.max(0, Math.min(1, v / 100)));
              }}
              onBlur={() => {}}
              className="w-full bg-transparent text-center text-[11px] text-text outline-none"
              spellCheck={false}
            />
            <span className="text-[10px] text-muted2">%</span>
          </div>
          {window.EyeDropper && (
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 bg-app transition-colors hover:bg-hover"
              title="Pick color from screen"
              onClick={pickFromScreen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
                <path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
              </svg>
            </button>
          )}
        </div>

        {/* Optional preset swatches */}
        {Array.isArray(presets) && presets.length > 0 && (
          <div className="border-t border-border/60 pt-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">Presets</div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onChange(p)}
                  className={[
                    "h-[20px] w-[20px] rounded-full border-2 transition-all hover:scale-110",
                    color?.toLowerCase() === p.toLowerCase()
                      ? "border-[rgb(var(--accent-color))] shadow-[0_0_0_1.5px_rgb(var(--accent-color))]"
                      : "border-transparent",
                  ].join(" ")}
                  style={{ background: p }}
                  title={p}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Gradient sub-components ─────────────────────────────────

function GradientStopsBar({ gradient, activeStop, onSelectStop }) {
  const fromCss = hexToRgba(gradient.from || "#000000", gradient.fromOpacity ?? 1);
  const toCss = hexToRgba(gradient.to || "#ffffff", gradient.toOpacity ?? 1);
  // Stop handles sit INSIDE the bar (not protruding) and are a thin vertical
  // line with a soft outline — visible enough to grab, never visually noisy.
  const Handle = ({ side, isActive, onClick }) => {
    const stopCss = side === "left" ? fromCss : toCss;
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Edit ${side === "left" ? "start" : "end"} stop`}
        className={[
          "absolute top-0 bottom-0 rounded-[2px] cursor-pointer transition-[width] duration-100",
          isActive ? "w-3" : "w-2",
        ].join(" ")}
        style={{
          [side]: "2px",
          background: stopCss,
          // Always neutral white + dark double-outline so handles read on any
          // gradient color. Active is signalled by being slightly WIDER, not
          // by a coloured ring (which collides with the brand accent).
          boxShadow: isActive
            ? "0 0 0 1.5px rgba(255,255,255,1), inset 0 0 0 1px rgba(0,0,0,0.35)"
            : "0 0 0 1px rgba(255,255,255,0.85), inset 0 0 0 1px rgba(0,0,0,0.25)",
        }}
      />
    );
  };
  return (
    <div className="relative h-6 flex-1">
      <div
        className="absolute inset-0 rounded"
        style={{
          background: `linear-gradient(90deg, ${fromCss}, ${toCss}), repeating-conic-gradient(#aaa 0% 25%, transparent 0% 50%) 50% / 6px 6px`,
        }}
      />
      <Handle side="left" isActive={activeStop === 0} onClick={(e) => { e.stopPropagation(); onSelectStop(0); }} />
      <Handle side="right" isActive={activeStop === 1} onClick={(e) => { e.stopPropagation(); onSelectStop(1); }} />
    </div>
  );
}

function hexToRgba(hex, alpha) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

