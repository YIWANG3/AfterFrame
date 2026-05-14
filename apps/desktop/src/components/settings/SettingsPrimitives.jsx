// Small shared building blocks for Settings tabs. Mirrors the mockup
// language: card-style groups with optional sub-caption, FieldRow with
// label + hint + right-side control.

export function Group({ title, subtitle, badge, children }) {
  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border bg-panel last:mb-0">
      {(title || subtitle) && (
        <div className="border-b border-border px-4 py-3">
          {title && (
            <div className="flex items-center gap-2 text-[12px] font-semibold text-text">
              <span>{title}</span>
              {badge && (
                <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-accent">
                  {badge}
                </span>
              )}
            </div>
          )}
          {subtitle && (
            <div className="mt-1 text-[11px] leading-snug text-muted2">{subtitle}</div>
          )}
        </div>
      )}
      <div className="px-4">{children}</div>
    </div>
  );
}

export function FieldRow({ label, hint, children, stack = false }) {
  if (stack) {
    return (
      <div className="border-b border-border/50 py-3 last:border-b-0">
        {(label || hint) && (
          <div className="mb-2">
            {label && <div className="text-[12px] text-text">{label}</div>}
            {hint && <div className="mt-1 text-[11px] leading-snug text-muted2">{hint}</div>}
          </div>
        )}
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        {label && <div className="text-[12px] text-text">{label}</div>}
        {hint && <div className="mt-1 text-[11px] leading-snug text-muted2">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

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

export function PrimaryButton({ onClick, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "h-7 rounded border border-accent bg-accent px-3 text-[11px] font-semibold text-app",
        "transition-colors hover:bg-accent/90",
        disabled ? "cursor-not-allowed opacity-50" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ onClick, children, disabled, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "h-7 rounded border border-border bg-app px-3 text-[11px] text-muted",
        "transition-colors hover:bg-hover hover:text-text",
        disabled ? "cursor-not-allowed opacity-50" : "",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Callout({ children, tone = "info" }) {
  const toneClass = tone === "info"
    ? "border-l-accent bg-accent/10 text-text"
    : "border-l-warn bg-warn/10 text-text";
  return (
    <div className={[
      "rounded-r-md border-l-2 px-3 py-2.5 text-[11px] leading-relaxed",
      toneClass,
    ].join(" ")}>
      {children}
    </div>
  );
}
