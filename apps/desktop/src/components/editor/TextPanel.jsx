import { useState, useCallback, useEffect, useRef } from "react";
import ColorPickerPopover from "../collage/ColorPickerPopover";

function hexToRgba(hex, alpha = 1) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
import {
  Plus, Trash2, Type,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Columns2, Rows2, ChevronDown, Check, Undo2, Redo2, RotateCcw,
} from "lucide-react";
import {
  FONT_OPTIONS, COLOR_SWATCHES, PRESETS,
  createDefaultLayer, applyPreset, cloneLayers,
} from "./textState";
import {
  alignLeft, alignCenterH, alignRight,
  alignTop, alignCenterV, alignBottom,
  distributeH, distributeV,
} from "./textAlign";

export default function TextPanel({
  layers = [],
  selectedIds = new Set(),
  onLayersChange,
  onSelectionChange,
  onApply,
  onReset,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}) {
  const selected = layers.filter((l) => selectedIds.has(l.id));
  const current = selected.length === 1 ? selected[0] : null;

  const update = useCallback((id, patch) => {
    onLayersChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, [layers, onLayersChange]);

  const addLayer = () => {
    const nl = createDefaultLayer();
    onLayersChange([...layers, nl]);
    onSelectionChange(new Set([nl.id]));
  };

  const deleteLayer = (id) => {
    onLayersChange(layers.filter((l) => l.id !== id));
    const next = new Set(selectedIds);
    next.delete(id);
    onSelectionChange(next);
  };

  const selectLayer = (id, e) => {
    if (e.shiftKey) {
      const next = new Set(selectedIds);
      next.has(id) ? next.delete(id) : next.add(id);
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([id]));
    }
  };

  return (
    <>
      <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
        {/* Presets */}
        <Section label="Presets">
          <div className="grid grid-cols-4 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className={[
                  "flex flex-col items-center gap-1 rounded-md border px-1 py-2 transition-colors",
                  current?.preset === p.name
                    ? "border-[rgb(var(--accent-color))] bg-[rgb(var(--accent-color)/0.08)]"
                    : "border-border/60 bg-app hover:border-border hover:bg-hover",
                ].join(" ")}
                onClick={() => {
                  const nl = createDefaultLayer({ text: "New Title" });
                  const styled = applyPreset(nl, p);
                  onLayersChange([...layers, styled]);
                  onSelectionChange(new Set([styled.id]));
                }}
              >
                <PresetPreview preset={p} />
                <span className={[
                  "text-[9px] whitespace-nowrap",
                  current?.preset === p.name ? "text-[rgb(var(--accent-color))]" : "text-muted2",
                ].join(" ")}>{p.name}</span>
              </button>
            ))}
          </div>
        </Section>

        {/* Text Layers */}
        <Section label="Text Layers" action={<IconBtn icon={Plus} onClick={addLayer} />}>
          <div className="flex flex-col gap-1">
            {layers.map((l) => (
              <div
                key={l.id}
                className={[
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                  selectedIds.has(l.id)
                    ? "bg-[rgb(var(--accent-color)/0.06)]"
                    : "hover:bg-hover",
                ].join(" ")}
                onClick={(e) => selectLayer(l.id, e)}
              >
                <Type className={["h-3.5 w-3.5 flex-shrink-0", selectedIds.has(l.id) ? "text-[rgb(var(--accent-color))]" : "text-muted2"].join(" ")} />
                <span className={["flex-1 truncate text-[11px]", selectedIds.has(l.id) ? "text-text" : "text-muted"].join(" ")}>{l.text || "Empty"}</span>
                <button
                  type="button"
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-0 transition-all group-hover:opacity-100 hover:bg-[rgb(var(--error-color)/0.15)] hover:text-[rgb(var(--error-color))]"
                  onClick={(e) => { e.stopPropagation(); deleteLayer(l.id); }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {selected.length >= 2 && <AlignBar layers={selected} onLayersChange={onLayersChange} allLayers={layers} />}
        </Section>

        {current && (
          <>
            {/* Content */}
            <Section label="Content">
              <textarea
                className="w-full resize-y rounded-md border border-border/60 bg-app px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none transition-colors placeholder:text-muted2 focus:border-[rgb(var(--accent-color))]"
                rows={2}
                value={current.text}
                onChange={(e) => update(current.id, { text: e.target.value })}
                placeholder="Enter text…"
              />
            </Section>

            {/* Font */}
            <Section label="Font">
              <FontSelect value={current.fontFamily} onChange={(f) => update(current.id, { fontFamily: f })} />
              <SliderRow label="Size" min={12} max={400} value={current.fontSize} onChange={(v) => update(current.id, { fontSize: v })} />
            </Section>

            {/* Style */}
            <Section label="Style">
              <div className="flex items-center gap-1.5">
                <WeightSelect value={current.fontWeight ?? (current.bold ? 700 : 400)} onChange={(w) => update(current.id, { fontWeight: w, bold: w >= 600 })} />
                <ToggleBtn active={current.italic} onClick={() => update(current.id, { italic: !current.italic })}><span className="text-[11px] italic">I</span></ToggleBtn>
                <ToggleBtn active={current.underline} onClick={() => update(current.id, { underline: !current.underline })}><span className="text-[11px] underline">U</span></ToggleBtn>
              </div>
            </Section>

            {/* Fill */}
            <Section label="Fill">
              <div className="flex gap-1">
                <ModeBtn active={current.fillMode === "solid"} onClick={() => update(current.id, { fillMode: "solid" })}>Solid</ModeBtn>
                <ModeBtn active={current.fillMode === "gradient"} onClick={() => update(current.id, { fillMode: "gradient" })}>Gradient</ModeBtn>
              </div>
              {current.fillMode === "solid" && (
                <SwatchRow
                  value={current.fillColor}
                  onChange={(c) => update(current.id, { fillColor: c })}
                  opacity={(current.fillOpacity ?? 100) / 100}
                  onOpacityChange={(v) => update(current.id, { fillOpacity: Math.round(v * 100) })}
                />
              )}
              {current.fillMode === "gradient" && (
                <div className="mt-2 space-y-2">
                  <div className="h-6 rounded" style={{ background: `linear-gradient(${current.gradientAngle}deg, ${hexToRgba(current.gradientFrom, (current.gradientFromOpacity ?? 100) / 100)}, ${hexToRgba(current.gradientTo, (current.gradientToOpacity ?? 100) / 100)}), repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px` }} />
                  <SliderRow label="Angle" min={0} max={360} value={current.gradientAngle} onChange={(v) => update(current.id, { gradientAngle: v })} suffix="°" />
                  <div className="flex gap-3">
                    <ColorDot label="From" color={current.gradientFrom} onChange={(c) => update(current.id, { gradientFrom: c })} opacity={(current.gradientFromOpacity ?? 100) / 100} onOpacityChange={(v) => update(current.id, { gradientFromOpacity: Math.round(v * 100) })} />
                    <ColorDot label="To" color={current.gradientTo} onChange={(c) => update(current.id, { gradientTo: c })} opacity={(current.gradientToOpacity ?? 100) / 100} onOpacityChange={(v) => update(current.id, { gradientToOpacity: Math.round(v * 100) })} />
                  </div>
                </div>
              )}
              <SliderRow label="Opacity" min={0} max={100} value={current.opacity} onChange={(v) => update(current.id, { opacity: v })} suffix="%" />
            </Section>

            {/* Stroke */}
            <Section label="Stroke" right={<Switch on={current.strokeEnabled} onToggle={() => update(current.id, { strokeEnabled: !current.strokeEnabled })} />}>
              {current.strokeEnabled && (
                <div className="flex items-center gap-2">
                  <ColorDot color={current.strokeColor} onChange={(c) => update(current.id, { strokeColor: c })} />
                  <span className="flex-1" />
                  <span className="text-[10px] text-muted2">Width</span>
                  <NumInput value={current.strokeWidth} min={0} max={20} onChange={(v) => update(current.id, { strokeWidth: v })} className="w-10" />
                </div>
              )}
            </Section>

            {/* Background */}
            <Section label="Background" right={<Switch on={current.bgMode === "solid"} onToggle={() => update(current.id, { bgMode: current.bgMode === "solid" ? "none" : "solid" })} />}>
              {current.bgMode === "solid" && (
                <>
                  <SwatchRow value={current.bgColor} onChange={(c) => update(current.id, { bgColor: c })} />
                  <SliderRow label="Opacity" min={0} max={100} value={current.bgOpacity} onChange={(v) => update(current.id, { bgOpacity: v })} suffix="%" />
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] text-muted2">Padding</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted2">H</span>
                      <NumInput value={current.bgPadH ?? 25} min={0} max={80} onChange={(v) => update(current.id, { bgPadH: v })} className="w-10" />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted2">V</span>
                      <NumInput value={current.bgPadV ?? 15} min={0} max={80} onChange={(v) => update(current.id, { bgPadV: v })} className="w-10" />
                    </div>
                  </div>
                </>
              )}
            </Section>

            {/* Shadow */}
            <Section label="Shadow" right={<Switch on={current.shadow} onToggle={() => update(current.id, { shadow: !current.shadow })} />}>
              {current.shadow && (
                <>
                  <div className="flex gap-2 rounded-md bg-app p-2">
                    <ShadowField label="X" value={current.shadowX} onChange={(v) => update(current.id, { shadowX: v })} min={-50} max={50} />
                    <ShadowField label="Y" value={current.shadowY} onChange={(v) => update(current.id, { shadowY: v })} min={-50} max={50} />
                    <ShadowField label="Blur" value={current.shadowBlur} onChange={(v) => update(current.id, { shadowBlur: v })} min={0} max={100} />
                    <ShadowField label="Spread" value={current.shadowSpread} onChange={(v) => update(current.id, { shadowSpread: v })} min={0} max={50} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 px-2">
                    <ColorDot color={current.shadowColor} onChange={(c) => update(current.id, { shadowColor: c })} />
                    <span className="flex-1" />
                    <SliderRow label="" min={0} max={100} value={current.shadowOpacity} onChange={(v) => update(current.id, { shadowOpacity: v })} suffix="%" compact />
                  </div>
                </>
              )}
            </Section>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-1 border-t border-border/60 px-3 py-2">
        <FooterBtn icon={RotateCcw} label="Reset" onClick={onReset} />
        <FooterBtn icon={Undo2} onClick={onUndo} disabled={!canUndo} />
        <FooterBtn icon={Redo2} onClick={onRedo} disabled={!canRedo} />
        <button
          type="button"
          className="ml-auto flex h-[30px] items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color))] px-4 text-[11px] font-semibold text-[#111] transition-all hover:brightness-110"
          onClick={onApply}
        >
          <Check className="h-3.5 w-3.5" /> Apply
        </button>
      </div>
    </>
  );
}

/* ── Sub-components ─────────────────────────────── */

function Section({ label, action, right, children }) {
  return (
    <div className="border-b border-border/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{label}</span>
        {action || right || null}
      </div>
      {children}
    </div>
  );
}

function IconBtn({ icon: Icon, onClick }) {
  return (
    <button type="button" className="flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text" onClick={onClick}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function ToggleBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={[
        "flex h-7 min-w-[32px] items-center justify-center rounded-md border px-2 text-[11px] font-semibold transition-colors",
        active
          ? "border-[rgb(var(--accent-color)/0.3)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
          : "border-border/60 text-muted hover:border-border hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >{children}</button>
  );
}

function ModeBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={[
        "flex-1 rounded-md border py-1.5 text-center text-[11px] transition-colors",
        active
          ? "border-[rgb(var(--accent-color)/0.3)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
          : "border-border/60 text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >{children}</button>
  );
}

function Switch({ on, onToggle }) {
  return (
    <button
      type="button"
      className={["relative h-[18px] w-8 rounded-full transition-colors", on ? "bg-[rgb(var(--accent-color))]" : "bg-border"].join(" ")}
      onClick={onToggle}
    >
      <span className={["absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform", on ? "translate-x-[14px]" : ""].join(" ")} />
    </button>
  );
}

function SwatchRow({ value, onChange, opacity, onOpacityChange }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const btnRef = useRef(null);

  return (
    <div className="mt-2 flex gap-1.5">
      {COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={[
            "h-[22px] w-[22px] rounded-full border-2 transition-all hover:scale-110",
            value === c ? "border-[rgb(var(--accent-color))] shadow-[0_0_0_1.5px_rgb(var(--accent-color))]" : "border-transparent",
          ].join(" ")}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <button
        ref={btnRef}
        type="button"
        className="h-[22px] w-[22px] rounded-full transition-all hover:scale-110"
        style={{ background: `conic-gradient(red, yellow, lime, aqua, blue, magenta, red)`, opacity: 0.7 }}
        title="Color picker"
        onClick={() => setPickerOpen(!pickerOpen)}
      />
      {pickerOpen && (
        <ColorPickerPopover
          color={value}
          onChange={onChange}
          onClose={() => setPickerOpen(false)}
          anchorEl={btnRef.current}
          opacity={opacity}
          onOpacityChange={onOpacityChange}
        />
      )}
    </div>
  );
}

function SliderRow({ label, min, max, value, onChange, suffix, compact }) {
  return (
    <div className={["flex items-center gap-2", compact ? "" : "mt-2"].join(" ")}>
      {label && <label className="min-w-[28px] text-[10px] text-muted2">{label}</label>}
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider flex-1"
      />
      <NumInput value={value} min={min} max={max} onChange={onChange} />
      {suffix && <span className="text-[10px] text-muted2">{suffix}</span>}
    </div>
  );
}

function NumInput({ value, min, max, onChange, className = "w-11" }) {
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
      className={`hide-spinner rounded-md border border-border/60 bg-app px-1.5 py-0.5 text-center text-[11px] text-text outline-none focus:border-[rgb(var(--accent-color))] focus:cursor-text ${className}`}
    />
  );
}

function ShadowField({ label, value, onChange, min, max }) {
  return (
    <div className="flex-1">
      <label className="mb-1 block text-[10px] text-muted2">{label}</label>
      <NumInput value={value} min={min} max={max} onChange={onChange} className="w-full" />
    </div>
  );
}

const WEIGHT_OPTIONS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "ExtraLight" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "SemiBold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "ExtraBold" },
  { value: 900, label: "Black" },
];

function WeightSelect({ value, onChange }) {
  const current = WEIGHT_OPTIONS.find((w) => w.value === value) || WEIGHT_OPTIONS[3];
  return (
    <select
      className="flex-1 rounded-md border border-border/60 bg-app px-2 py-1.5 text-[11px] text-text outline-none transition-colors hover:border-border focus:border-[rgb(var(--accent-color))]"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {WEIGHT_OPTIONS.map((w) => (
        <option key={w.value} value={w.value}>{w.label}</option>
      ))}
    </select>
  );
}

function FontSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState([]);
  const [filter, setFilter] = useState("");
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        // Prefer Chromium's queryLocalFonts (works in packaged Electron)
        if (window.queryLocalFonts) {
          const fontData = await window.queryLocalFonts();
          const families = [...new Set(fontData.map((f) => f.family))].sort();
          setSystemFonts(families);
          return;
        }
      } catch {}
      // Fallback to IPC
      try {
        const fonts = await window.mediaWorkspace?.listSystemFonts?.();
        if (Array.isArray(fonts)) setSystemFonts(fonts);
      } catch {}
    })();
  }, []);

  const allFonts = [
    ...FONT_OPTIONS.map((f) => f.family),
    ...systemFonts.filter((f) => !FONT_OPTIONS.some((o) => o.family === f)),
  ];

  const filtered = filter
    ? allFonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    : allFonts;

  return (
    <div className="relative">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-app px-2.5 py-1.5 transition-colors hover:border-border"
        onClick={() => setOpen(!open)}
      >
        <span className="flex-1 text-left text-[11px] text-text" style={{ fontFamily: value }}>{value}</span>
        <span className="text-[11px] text-muted" style={{ fontFamily: value }}>Aa</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted2" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-chrome shadow-lg">
          <div className="border-b border-border/60 px-2 py-1.5">
            <input
              type="text"
              className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-muted2"
              placeholder="Search fonts…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((family) => (
              <button
                key={family}
                type="button"
                className={[
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-hover",
                  value === family ? "text-[rgb(var(--accent-color))]" : "text-text",
                ].join(" ")}
                style={{ fontFamily: `"${family}", sans-serif` }}
                onClick={() => { onChange(family); setOpen(false); setFilter(""); }}
              >
                <span className="flex-1">{family}</span>
                <span className="text-muted">Aa</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">No fonts found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColorDot({ label, color, onChange, opacity, onOpacityChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const hasAlpha = opacity != null && opacity < 1;
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-[10px] text-muted2">{label}</span>}
      <div
        ref={ref}
        className="h-5 w-5 cursor-pointer rounded border border-border/60"
        style={{ background: hasAlpha ? `linear-gradient(${hexToRgba(color, opacity)}, ${hexToRgba(color, opacity)}), repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 6px 6px` : color }}
        onClick={() => onChange && setOpen(!open)}
      />
      {open && onChange && (
        <ColorPickerPopover
          color={color}
          onChange={onChange}
          opacity={opacity}
          onOpacityChange={onOpacityChange}
          onClose={() => setOpen(false)}
          anchorEl={ref.current}
        />
      )}
    </div>
  );
}

function FooterBtn({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      className="flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40 disabled:pointer-events-none"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-3.5 w-3.5" />
      {label && <span>{label}</span>}
    </button>
  );
}

function PresetPreview({ preset }) {
  const s = preset.style;
  const style = {
    fontSize: "16px",
    fontWeight: s.bold ? 700 : 400,
    fontFamily: s.fontFamily || "Plus Jakarta Sans",
    color: s.fillColor === "transparent" ? "transparent" : (s.fillColor || "#fff"),
    WebkitTextStroke: s.strokeEnabled ? `${s.strokeWidth || 1}px ${s.strokeColor || "#fff"}` : undefined,
    textShadow: s.shadow ? `${s.shadowX || 0}px ${s.shadowY || 0}px ${s.shadowBlur || 0}px ${s.shadowColor || "#000"}` : undefined,
    opacity: s.opacity != null ? s.opacity / 100 : 1,
  };
  const bg = s.bgMode === "solid" ? { background: s.bgColor || "#000", padding: "2px 6px", borderRadius: "3px" } : {};
  return <div className="flex h-7 items-center justify-center" style={{ ...style, ...bg }}>Aa</div>;
}

function AlignBar({ layers, onLayersChange, allLayers }) {
  const ids = new Set(layers.map((l) => l.id));
  const apply = (fn) => {
    const updated = fn(layers);
    const map = new Map(updated.map((l) => [l.id, l]));
    onLayersChange(allLayers.map((l) => map.get(l.id) || l));
  };

  const abtn = "flex h-6 w-6 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text";
  const sep = "mx-0.5 h-3.5 w-px bg-border/60";

  return (
    <div className="mt-2 flex items-center gap-0.5 rounded-md bg-app p-1">
      <button type="button" className={abtn} title="Align left" onClick={() => apply(alignLeft)}><AlignHorizontalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Center H" onClick={() => apply(alignCenterH)}><AlignHorizontalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Align right" onClick={() => apply(alignRight)}><AlignHorizontalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title="Align top" onClick={() => apply(alignTop)}><AlignVerticalJustifyStart className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Center V" onClick={() => apply(alignCenterV)}><AlignVerticalJustifyCenter className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Align bottom" onClick={() => apply(alignBottom)}><AlignVerticalJustifyEnd className="h-3.5 w-3.5" /></button>
      <div className={sep} />
      <button type="button" className={abtn} title="Distribute H" onClick={() => apply(distributeH)}><Columns2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={abtn} title="Distribute V" onClick={() => apply(distributeV)}><Rows2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}
