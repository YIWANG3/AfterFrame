import cx from "./cx";

// The app's button vocabulary. Variants map to what was previously seven
// local re-implementations (TOOLBAR_BUTTON/ACCENT_BUTTON consts, FooterButton,
// IconButton, OverlayButton, PrimaryButton/SecondaryButton...).
//
//  primary    accent-filled call to action
//  secondary  bordered neutral
//  ghost      borderless, hover reveals
//  icon       square h-8 w-8 icon-only (toolbar style)
//  danger     destructive bordered (delete)
const VARIANTS = {
  primary:
    "inline-flex h-8 items-center justify-center rounded-md bg-[rgb(var(--accent-color))] px-3 py-0 text-[12px] font-medium text-black transition-colors hover:brightness-110",
  secondary:
    "inline-flex h-8 items-center justify-center rounded-md border border-border/70 bg-app px-3 py-0 text-[12px] font-medium text-text transition-colors hover:border-border hover:bg-hover",
  ghost:
    "inline-flex h-8 items-center justify-center rounded-md px-2 py-0 text-[12px] text-muted2 transition-colors hover:bg-hover hover:text-text",
  icon:
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-40",
  danger:
    "inline-flex h-8 items-center justify-center rounded-md border border-rose-500/30 bg-app px-3 py-0 text-[12px] font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10",
};

export default function Button({ variant = "secondary", className = "", type = "button", children, ...rest }) {
  return (
    <button type={type} className={cx(VARIANTS[variant], className)} {...rest}>
      {children}
    </button>
  );
}

// Raw class strings for places that need the look on a non-<button> element
// (labels, links) or want to compose manually.
export const BUTTON_VARIANTS = VARIANTS;
