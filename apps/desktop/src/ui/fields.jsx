// Form field primitives — promoted from settings/SettingsPrimitives so the
// whole app (not just the Settings tabs) shares one implementation.
// SettingsPrimitives re-exports these for backwards compatibility.
//
// Every field (TextInput, Select, TextArea, NumberInput, the SliderRow's
// value box) wears the same chrome: no border, fill-2, a 1px inset ring on
// focus. The radius follows the height — 24 px fields are 6 px, 28 and 32 px
// fields 8 px — so a row of mixed controls stays concentric. Panels used to
// force this on with container CSS (index.css §8c / §10b); it lives here now.

import cx from "./cx";

export const FIELD_SIZE = {
  sm: "h-6 rounded-[6px] px-2 text-[11px]",   // the editor's tool panels, popovers
  md: "h-7 rounded-[8px] px-2.5 text-[12px]", // Settings rows
  lg: "h-8 rounded-[8px] px-2.5 text-[12px]", // dialogs, the AI panel
};
export const FIELD_CHROME =
  "bg-[var(--fill-2)] text-text outline-none placeholder:text-muted2/60 focus:shadow-[inset_0_0_0_1px_var(--fill-3)] focus-within:shadow-[inset_0_0_0_1px_var(--fill-3)] disabled:opacity-50";

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
        // Off track must stay visible on a fill-coloured card: fill-3 + a faint inner ring.
        on ? "bg-accent" : "bg-[var(--fill-3)] shadow-[inset_0_0_0_0.5px_rgb(var(--text-color)/0.12)]",
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

// A small labelled checkbox for tool chrome (header bars, panel footers): the
// label truncates to one line and the full text is the tooltip.
export function Checkbox({ label, checked, onChange, testId, className = "" }) {
  return (
    <label
      className={[
        "flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-text",
        className,
      ].join(" ")}
      title={label}
    >
      <input
        type="checkbox"
        data-testid={testId}
        className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent-color))]"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

export function TextInput({ value, onChange, type = "text", placeholder, monospace, size = "sm", leading, className = "", ...rest }) {
  const input = (
    <input
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={cx(
        leading ? "h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted2/60" : cx(FIELD_SIZE[size], FIELD_CHROME),
        monospace && "font-mono",
        !leading && className,
      )}
      {...rest}
    />
  );
  if (!leading) return input;
  // An icon inside the field (a key, a magnifier): the wrapper wears the chrome.
  return (
    <div className={cx("flex items-center gap-2", FIELD_SIZE[size], FIELD_CHROME, className)}>
      <span className="flex shrink-0 items-center text-muted2">{leading}</span>
      {input}
    </div>
  );
}

// A multi-line field. Grows with `rows`; the radius is the 28 px fields'.
export function TextArea({ value, onChange, className = "", rows = 3, ...rest }) {
  return (
    <textarea
      value={value ?? ""}
      rows={rows}
      onChange={(e) => onChange?.(e.target.value)}
      className={cx("w-full resize-y rounded-[8px] px-2.5 py-2 text-[12px] leading-relaxed", FIELD_CHROME, className)}
      {...rest}
    />
  );
}

const CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")";

// `options`: [{ value, label }] or [{ label, options: [...] }] for groups —
// or pass <option> children for the odd conditional list.
export function Select({ value, onChange, options, size = "sm", className = "", children, ...rest }) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      className={cx(FIELD_SIZE[size], FIELD_CHROME, "cursor-pointer appearance-none pr-7", className)}
      style={{ backgroundImage: CHEVRON, backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center", backgroundSize: "12px 12px" }}
      {...rest}
    >
      {children ?? options.map((opt, i) =>
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

// A choice among a few (a size, a mode). `pill` (default) is the accent
// pill; `option` is the tool panels' flat rounded-md chip, lit with the
// selection colour (the collage panel's ratios, export widths, grouping).
const CHIP_VARIANTS = {
  pill: {
    base: "inline-flex h-7 items-center rounded-full px-3 text-[11px] transition-colors",
    on: "bg-accent text-accentInk",
    off: "bg-[var(--fill-2)] text-muted hover:bg-[var(--fill-3)] hover:text-text",
  },
  option: {
    base: "rounded-md px-2.5 py-1 text-[11px] transition-colors",
    on: "bg-selected text-text",
    off: "bg-app text-muted hover:bg-hover hover:text-text",
  },
};

export function Chip({ on, onClick, variant = "pill", children }) {
  const v = CHIP_VARIANTS[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      className={[v.base, on ? v.on : v.off].join(" ")}
    >
      {children}
    </button>
  );
}
