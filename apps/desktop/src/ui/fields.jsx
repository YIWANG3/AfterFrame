// Form field primitives — promoted from settings/SettingsPrimitives so the
// whole app (not just the Settings tabs) shares one implementation.
// SettingsPrimitives re-exports these for backwards compatibility.

export function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={[
        "relative h-[18px] w-[30px] rounded-full transition-colors",
        on ? "bg-accent" : "bg-hover",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all",
          on ? "left-[14px]" : "left-[2px]",
        ].join(" ")}
      />
    </button>
  );
}

export function TextInput({ value, onChange, type = "text", placeholder, monospace, className = "", ...rest }) {
  return (
    <input
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={[
        "h-7 rounded border border-border bg-app px-2.5 text-[12px] text-text outline-none",
        "placeholder:text-muted2/60 focus:border-accent",
        monospace ? "font-mono" : "",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, className = "", suffix }) {
  function handle(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return;
    let next = n;
    if (Number.isFinite(min) && next < min) next = min;
    if (Number.isFinite(max) && next > max) next = max;
    onChange?.(next);
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => handle(e.target.value)}
        className={[
          "h-7 rounded border border-border bg-app px-2 text-right text-[12px] tabular-nums text-text outline-none focus:border-accent",
          className || "w-[72px]",
        ].join(" ")}
      />
      {suffix && <span className="text-[10px] text-muted2">{suffix}</span>}
    </div>
  );
}

export function Select({ value, onChange, options, className = "" }) {
  // options: [{ value, label }] or [{ label, options: [...] }] for groups
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      className={[
        "h-7 rounded border border-border bg-app px-2.5 pr-7 text-[12px] text-text outline-none focus:border-accent",
        className || "min-w-[200px]",
      ].join(" ")}
      style={{
        appearance: "none",
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
      }}
    >
      {options.map((opt, i) =>
        opt.options ? (
          <optgroup key={i} label={opt.label}>
            {opt.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        ) : (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ),
      )}
    </select>
  );
}

export function Chip({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
        on
          ? "border-accent bg-accent/15 text-accent"
          : "border-border bg-app text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      {on && <span className="h-[5px] w-[5px] rounded-full bg-accent" />}
      {children}
    </button>
  );
}
