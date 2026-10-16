import cx from "./cx";

// The app's button vocabulary: a look (`variant`) at a size.
//
//  primary    accent-filled call to action
//  secondary  bordered neutral
//  soft       neutral fill, no border
//  ghost      borderless, hover reveals
//  tint       accent-tinted text button (the editor's Save, the collage's
//             Export, the dev notice's Restart)
//  icon       square icon-only (toolbar style)
//  danger     destructive bordered (delete)
//
//  md         h-8, 12px text — the app's default
//  sm         h-7, 11px text — the editor and collage headers, Settings' rows
//  xs         h-6 — a modal's close cross
//
// The size is a prop, not a className override: Tailwind orders arbitrary
// values alphabetically, so `h-7 text-[11px]` appended to the md classes
// loses to them. index.css (the Tahoe skin) still recolours
// `border-border/70 bg-app` into a filled pill; the radius is decided here.
// Every variant takes the radius of its size (xs 6px, sm / md 8px), so a
// button matches the fields and buttons beside it. `pill` is a role, not a
// look: the editor's and the collage's header actions (Save, Export) sit in
// a bar of pills and pass it; a panel or dialog footer never does.
const LOOKS = {
  primary: "bg-[rgb(var(--accent-color))] font-medium text-accentInk hover:brightness-110",
  secondary: "border border-border/70 bg-app font-medium text-text hover:border-border hover:bg-hover",
  soft: "bg-[var(--fill-2)] font-medium text-text hover:bg-[var(--fill-3)]",
  ghost: "text-muted2 hover:bg-hover hover:text-text",
  tint: "gap-1.5 bg-accent/10 font-medium text-accent hover:bg-accent/[0.18] disabled:opacity-60",
  icon: "text-muted hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-40",
  danger: "border border-rose-500/30 bg-app font-medium text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/10",
};

const SIZES = {
  md: { text: "h-8 px-3 py-0 text-[12px]", ghost: "h-8 px-2 py-0 text-[12px]", icon: "h-8 w-8" },
  sm: { text: "h-7 px-3 py-0 text-[11px]", ghost: "h-7 px-2 py-0 text-[11px]", icon: "h-7 w-7" },
  xs: { text: "h-6 px-2 py-0 text-[11px]", ghost: "h-6 px-1.5 py-0 text-[11px]", icon: "h-6 w-6" },
};

function sizeClasses(variant, size) {
  const s = SIZES[size] ?? SIZES.md;
  if (variant === "icon") return s.icon;
  if (variant === "ghost") return s.ghost;
  return s.text;
}

export default function Button({ variant = "secondary", size = "md", pill = false, className = "", type = "button", children, ...rest }) {
  return (
    <button
      type={type}
      className={cx("inline-flex items-center justify-center transition-colors", pill ? "rounded-full" : size === "xs" ? "rounded" : "rounded-md", sizeClasses(variant, size), LOOKS[variant], className)}
      {...rest}
    >
      {children}
    </button>
  );
}
