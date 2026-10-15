// A tool panel's footer button (Reset / Undo / Redo / Apply): an icon, a
// label or both; `primary` is the accent-filled Apply.

export default function FooterButton({ icon: Icon, label, onClick, disabled = false, primary = false, testId }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={[
        "inline-flex h-8 items-center rounded-md text-[11px] font-medium transition-colors disabled:cursor-default disabled:opacity-35",
        label ? "gap-1.5 px-3" : "w-8 justify-center",
        primary
          ? "bg-[rgb(var(--accent-color))] text-accentInk hover:brightness-110"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {label ? <span>{label}</span> : null}
    </button>
  );
}
