// The manager page's chrome, shared by its three tabs (FoldersView for
// collections, ManagerPages.jsx for smart collections and folders): the
// gallery toolbar's icon button and sort button, and the page's empty state.
// One markup, so the skin dresses every tab as it dresses the gallery.
import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button, cx, Z } from "../ui";
import useDismiss from "../ui/useDismiss";

export function ToolbarIconButton({ className = "", ...props }) {
  return <Button variant="icon" className={cx("cursor-pointer disabled:hover:bg-transparent", className)} {...props} />;
}

// Toolbar.jsx's sort button. `options`: [{ value, label }].
export function ToolbarSortDropdown({ value, onChange, options, title, testId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, () => setOpen(false), { enabled: open });
  const current = options.find((option) => option.value === value) || options[0];
  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        data-testid={testId}
        title={title}
        className="flex h-8 w-[120px] cursor-pointer items-center justify-center rounded-md border border-border/70 bg-app px-2 text-[12px] text-text outline-none transition-colors hover:border-border focus:border-accent/50"
        onClick={() => setOpen((c) => !c)}
      >
        <span className="truncate">{current?.label}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 min-w-[170px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ zIndex: Z.dropdown }}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cx(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
                value === option.value ? "text-text" : "text-muted",
              )}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {value === option.value && <Check className="h-3 w-3 text-accent" />}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Nothing on the tab yet: what it is, and the way to make the first one.
export function ManagerEmptyState({ icon: Icon, title, hint, action = null, testId }) {
  return (
    <div data-testid={testId} className="flex h-[260px] flex-col items-center justify-center gap-3 rounded-[18px] bg-[var(--fill)] text-center">
      <Icon className="h-8 w-8 stroke-[1.4] text-muted2" />
      <div className="text-[13px] text-text">{title}</div>
      {hint && <div className="max-w-[360px] text-[12px] text-muted2">{hint}</div>}
      {action && <Button variant="secondary" size="sm" onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}
