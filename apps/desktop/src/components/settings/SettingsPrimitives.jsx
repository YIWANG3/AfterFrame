// Small shared building blocks for Settings tabs. Mirrors the mockup

// Field primitives now live in src/ui — re-exported here so existing
// settings-tab imports keep working unchanged.
export { Toggle, TextInput, NumberInput, Select, Chip } from "../../ui/fields";
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
