import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Brain, FolderOpen, Info, Wand2, Languages, Plug, UsersRound } from "lucide-react";
import GeneralSettings from "./settings/GeneralSettings";
import AnnotationSettings from "./settings/AnnotationSettings";
import RepaintSettings from "./settings/RepaintSettings";
import LibrarySettings from "./settings/LibrarySettings";
import IntegrationsSettings from "./settings/IntegrationsSettings";
import AboutSettings from "./settings/AboutSettings";
import PeopleSettings from "./settings/PeopleSettings";

/* ─── SettingsOverlay ─────────────────────────────────────────
   Full-screen modal hosting all global Settings tabs. The same
   shell pattern as EditorOverlay / CollageOverlay — fixed
   backdrop, centered modal, ESC + backdrop click close. */

const TABS = [
  { id: "general", key: "general", icon: Languages },
  { id: "ai", key: "ai", icon: Brain },
  { id: "repaint", key: "repaint", icon: Wand2 },
  { id: "people", key: "people", icon: UsersRound },
  { id: "library", key: "library", icon: FolderOpen },
  { id: "integrations", key: "integrations", icon: Plug },
  { id: "about", key: "about", icon: Info },
];

export default function SettingsOverlay({
  open,
  initialTab = "ai",
  onClose,
  theme,
  setTheme,
  info,
  summary,
  onSwitchCatalog,
}) {
  const [tab, setTab] = useState(initialTab);
  const { t } = useTranslation("settings");
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
          <span className="text-[14px] font-semibold text-text">{t("title")}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text"
            title={t("close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* aria-label distinguishes this tab list from the sidebar navigation
              (both are <nav>; "People" exists in each). */}
          <nav aria-label={t("title")} className="w-40 shrink-0 border-r border-border px-2 py-2">
            {TABS.map((entry) => {
              const Icon = entry.icon;
              const active = tab === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTab(entry.id)}
                  className={[
                    "mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                    active ? "bg-accent/10 text-accent" : "text-muted hover:bg-hover hover:text-text",
                  ].join(" ")}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(`tabs.${entry.key}`)}</span>
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto bg-chrome px-7 py-6">
            {tab === "general" && <GeneralSettings theme={theme} setTheme={setTheme} />}
            {tab === "ai" && <AnnotationSettings />}
            {tab === "repaint" && <RepaintSettings />}
            {tab === "people" && <PeopleSettings />}
            {tab === "library" && (
              <LibrarySettings info={info} summary={summary} onSwitchCatalog={onSwitchCatalog} onClose={onClose} />
            )}
            {tab === "integrations" && <IntegrationsSettings />}
            {tab === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
