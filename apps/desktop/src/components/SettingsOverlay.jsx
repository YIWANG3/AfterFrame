import { useEffect, useRef, useState } from "react";
import { X, Brain, FolderOpen, Info } from "lucide-react";
import AnnotationSettings from "./settings/AnnotationSettings";
import LibrarySettings from "./settings/LibrarySettings";
import AboutSettings from "./settings/AboutSettings";

/* ─── SettingsOverlay ─────────────────────────────────────────
   Full-screen modal hosting all global Settings tabs. The same
   shell pattern as EditorOverlay / CollageOverlay — fixed
   backdrop, centered modal, ESC + backdrop click close. */

const TABS = [
  { id: "ai", label: "AI", icon: Brain },
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsOverlay({ open, initialTab = "ai", onClose }) {
  const [tab, setTab] = useState(initialTab);
  const modalRef = useRef(null);

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose?.(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center bg-app/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={modalRef}
        className="flex w-[880px] max-w-[95vw] h-[680px] max-h-[88vh] flex-col overflow-hidden rounded-xl border border-border bg-chrome shadow-overlay"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
          <span className="text-[14px] font-semibold text-text">Settings</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 border-r border-border px-2 py-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={[
                    "mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                    active ? "bg-accent/10 text-accent" : "text-muted hover:bg-hover hover:text-text",
                  ].join(" ")}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto bg-chrome px-7 py-6">
            {tab === "ai" && <AnnotationSettings />}
            {tab === "library" && <LibrarySettings />}
            {tab === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
