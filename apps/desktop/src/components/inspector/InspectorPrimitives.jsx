// The right pane's building blocks, shared by the photo Inspector and the
// sticker view's detail pane: a label/value row and a collapsible section.

import { useState } from "react";
import { ChevronRight } from "lucide-react";

export function DetailRow({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[12px] leading-[1.4]">
      <div className="shrink-0 text-muted">{label}</div>
      <div className="min-w-0 break-words text-right text-text">{children}</div>
    </div>
  );
}

export function Section({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{title}</span>
        <ChevronRight className={`h-3 w-3 text-muted2 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
