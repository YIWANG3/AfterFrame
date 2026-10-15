// The facet chip and the panel it opens, the include / exclude switch at
// the top of a list, and the class the bar's action chips share.

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Z } from "../../ui";
import useDismiss from "../../ui/useDismiss";

// Shared popover shell. The panel is portaled to <body> and fixed-positioned
// under the trigger, so it can't be clipped or covered by sibling panels
// (e.g. the Inspector) regardless of stacking context.
export default function Popover({ label, active, summary, children, width = 220, excluded = false }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // Below the chip when the list fits there; otherwise above it, or pinned to
  // the window's bottom edge. A chip low on the screen (a group in the
  // condition-groups dialog, on a small window) must not open off-screen.
  // Re-placed when the list changes size (options arriving, a search).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return undefined;
    function place() {
      const r = btnRef.current.getBoundingClientRect();
      const estWidth = width === "auto" ? 480 : width;
      let left = r.left;
      if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - estWidth);
      const h = panelRef.current?.offsetHeight || 0;
      let top = r.bottom + 4;
      if (h && top + h > window.innerHeight - 8) {
        top = r.top - 4 - h >= 8 ? r.top - 4 - h : Math.max(8, window.innerHeight - 8 - h);
      }
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    }
    place();
    const observer = panelRef.current ? new ResizeObserver(place) : null;
    if (observer) observer.observe(panelRef.current);
    return () => observer?.disconnect();
  }, [open, width]);

  useDismiss([btnRef, panelRef], () => setOpen(false), { enabled: open });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((c) => !c)}
        data-excluded={excluded ? "true" : undefined}
        className={[
          "flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
          active ? "border-accent/50 bg-accent/10 text-text" : "border-border/70 bg-app text-muted hover:border-border hover:text-text",
        ].join(" ")}
      >
        <span className="max-w-[160px] truncate">{active ? summary : label}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted2" />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          data-popover-panel="true"
          className="fixed rounded-lg border border-border/60 bg-chrome p-2 shadow-overlay"
          style={{ left: pos.left, top: pos.top, width: width === "auto" ? undefined : width, zIndex: Z.popover }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

export const MODE_LABELS = { any: "filter.match.any", all: "filter.match.all", include: "filter.matchInclude", exclude: "filter.matchExclude" };

// The switch at the top of a facet's list: include / exclude, and for several
// tags any / all / exclude ("night AND neon", "none of these").
export function MatchModes({ modes, mode, onMode }) {
  const { t } = useTranslation("nav");
  return (
    <div className="mb-1.5 flex gap-1 rounded-md bg-app p-0.5" data-facet-match="true">
      {modes.map((option) => (
        <button
          key={option}
          type="button"
          data-facet-mode={option}
          aria-pressed={mode === option}
          onClick={() => onMode(option)}
          className={[
            "h-5 flex-1 rounded text-[10px] transition-colors",
            mode === option ? "bg-selected text-text" : "text-muted2 hover:text-text",
          ].join(" ")}
        >
          {t(MODE_LABELS[option])}
        </button>
      ))}
    </div>
  );
}

// The bar floats over the photos, so anything in it needs a surface of its own:
// bare text ("Clear", "Save as smart collection") vanishes against an image.
// These are the facet chips' classes, which is also what the skin hangs the
// glass pill on (index.css: `.flex-wrap.border-b button.rounded-md.border`).
export const ACTION_CHIP = "flex h-6 items-center gap-1 rounded-md border border-border/70 bg-app px-2 text-[11px] text-muted transition-colors hover:border-border hover:text-text";
