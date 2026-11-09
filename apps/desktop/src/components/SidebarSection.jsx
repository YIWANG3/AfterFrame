// A sidebar section that folds to its heading. Smart collections and folders
// share the sidebar's height; folding one gives the other the room. Open
// unless folded; the fold is remembered per section.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";

const OPEN_KEY = "sidebar.sectionOpen";

export function readSectionOpen(id) {
  try { return localStorage.getItem(`${OPEN_KEY}:${id}`) !== "0"; } catch { return true; }
}

function writeSectionOpen(id, open) {
  try { localStorage.setItem(`${OPEN_KEY}:${id}`, open ? "1" : "0"); } catch { /* private mode */ }
}

// [open, toggle, show]: `show` unfolds for something that needs the rows on
// screen (a new folder's name field), and is a no-op when already open.
export function useSectionOpen(id) {
  const [open, setOpen] = useState(() => readSectionOpen(id));
  const toggle = () => setOpen((current) => { writeSectionOpen(id, !current); return !current; });
  const show = () => { if (!open) { writeSectionOpen(id, true); setOpen(true); } };
  return [open, toggle, show];
}

// `holdsActive`: the folded section contains what the gallery is showing,
// marked with a dot beside the heading. `children` are the section's own
// tools (search, sort, new folder), which sit beside the heading and never
// toggle it. Anything else (`className`, drag handlers, data attributes) goes
// on the heading row, which the folders section uses as a drop target.
export function SectionHeading({ id, label, open, onToggle, holdsActive = false, className = "", children, ...rest }) {
  const { t } = useTranslation("nav");
  return (
    <div className={`flex shrink-0 items-center justify-between px-2.5 pb-1.5 ${className}`} {...rest}>
      <button
        type="button"
        data-sidebar-section-toggle={id}
        aria-expanded={open}
        title={open ? t("sidebar.collapse") : t("sidebar.expand")}
        onClick={onToggle}
        className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-muted2 transition-colors hover:text-text"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</span>
        {!open && holdsActive && <span data-section-active="true" className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      </button>
      {children && <span className="flex items-center gap-0.5">{children}</span>}
    </div>
  );
}
