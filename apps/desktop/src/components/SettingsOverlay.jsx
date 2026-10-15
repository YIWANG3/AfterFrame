import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Brain, FolderOpen, Info, Wand2, Languages, Plug, Stamp, UsersRound, Keyboard } from "lucide-react";
import api from "../api";
import { DesktopOnlyPane, LOCKED_HINT_KEY } from "./DesktopOnly";
import { TOP_LAYER_ATTR } from "../utils/topLayer";
import { oneOf, readPref, writePref } from "../utils/prefs";
import GeneralSettings from "./settings/GeneralSettings";
import AnnotationSettings from "./settings/AnnotationSettings";
import RepaintSettings from "./settings/RepaintSettings";
import LibrarySettings from "./settings/LibrarySettings";
import IntegrationsSettings from "./settings/IntegrationsSettings";
import AboutSettings from "./settings/AboutSettings";
import PeopleSettings from "./settings/PeopleSettings";
import WatermarkSettings from "./settings/WatermarkSettings";
import ShortcutsSettings from "./settings/ShortcutsSettings";
import { matchShortcut } from "../shortcuts/store";
import { Button, Modal } from "../ui";

/* ─── SettingsOverlay ─────────────────────────────────────────
   Full-screen modal hosting all global Settings tabs. The same
   shell pattern as EditorOverlay / CollageOverlay — fixed
   backdrop, centered modal, ESC + backdrop click close. */

// `cap` marks tabs a bridge may declare desktop-only (api.can): the tab stays
// visible with a "Desktop" badge and its pane renders dimmed inside
// DesktopOnlyPane, advertising what the desktop app offers.
const TABS = [
  { id: "general", key: "general", icon: Languages },
  { id: "shortcuts", key: "shortcuts", icon: Keyboard },
  { id: "ai", key: "ai", icon: Brain, cap: "annotation" },
  { id: "repaint", key: "repaint", icon: Wand2, cap: "aiRepaint" },
  { id: "people", key: "people", icon: UsersRound, cap: "people" },
  { id: "watermark", key: "watermark", icon: Stamp },
  { id: "library", key: "library", icon: FolderOpen, cap: "libraryManagement" },
  { id: "integrations", key: "integrations", icon: Plug, cap: "integrations" },
  { id: "about", key: "about", icon: Info },
];

// Settings opens on the tab it was left on (utils/prefs.js), unless the
// caller asks for one.
const TAB_PREF = "settings.tab";
const rememberedTab = () => readPref(TAB_PREF, "general", oneOf(TABS.map((entry) => entry.id)));

// Escape, or the Settings key itself (⌘, unless rebound), closes Settings.
const isCloseKey = (event) => event.key === "Escape" || matchShortcut(event, ["global"])?.id === "app.settings";

export default function SettingsOverlay({
  open,
  initialTab = null,
  onClose,
  theme,
  setTheme,
  info,
  summary,
  onSwitchCatalog,
}) {
  const [tab, setTab] = useState(() => initialTab || rememberedTab());
  const { t } = useTranslation("settings");
  const rootRef = useRef(null);

  useEffect(() => { if (open) setTab(initialTab || rememberedTab()); }, [open, initialTab]);

  // Settings opens over whatever view is up (editor, collage, lightbox) and
  // owns the keyboard while it is: focus moves in, and keys stop at its root
  // (utils/topLayer.js), so Escape closes Settings alone and nothing typed
  // here reaches a canvas below.
  useEffect(() => {
    if (open && !rootRef.current?.contains(document.activeElement)) rootRef.current?.focus({ preventScroll: true });
  }, [open]);
  // Focus can still be outside: back on <body> (a field blurred on Enter, a
  // dialog closed), or on whatever held it when Settings opened over it and
  // took it back before the focus above landed (seen on a slow CI runner:
  // Escape went to the gallery and Settings stayed open). Settings is modal,
  // so a key aimed anywhere outside it is Settings' too.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (rootRef.current?.contains(e.target)) return;
      e.stopPropagation();
      if (isCloseKey(e)) { e.preventDefault(); onClose?.(); }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  // Escape is handled here, not by the shell: the close key is rebindable
  // and an inline rename may have claimed it first.
  return (
    <Modal
      ref={rootRef}
      tabIndex={-1}
      {...{ [TOP_LAYER_ATTR]: "true" }}
      data-settings-overlay=""
      z="settings"
      backdrop="app"
      escape={false}
      rootClassName="outline-none"
      onClose={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        // An inline rename handles its own Escape (and marks it handled).
        if (isCloseKey(e) && !e.defaultPrevented) { e.preventDefault(); onClose?.(); }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      size="w-[880px] max-w-[95vw] h-[680px] max-h-[88vh]"
      className="flex flex-col"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
        <span className="text-[14px] font-semibold text-text">{t("title")}</span>
        <Button variant="icon" size="xs" className="text-muted2" onClick={onClose} title={t("close")}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* aria-label distinguishes this tab list from the sidebar navigation
            (both are <nav>; "People" exists in each). */}
        <nav aria-label={t("title")} className="w-40 shrink-0 border-r border-border px-2 py-2">
          {TABS.map((entry) => {
            const Icon = entry.icon;
            const active = tab === entry.id;
            const locked = !api.can(entry.cap);
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => { setTab(entry.id); writePref(TAB_PREF, entry.id); }}
                title={locked ? t(LOCKED_HINT_KEY, { ns: "common" }) : undefined}
                className={[
                  "mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  active ? "bg-accent/10 text-accent" : locked ? "text-muted2 hover:bg-hover" : "text-muted hover:bg-hover hover:text-text",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t(`tabs.${entry.key}`)}</span>
              </button>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto bg-chrome px-7 py-6">
          {(() => {
            const pane = (
              <>
                {tab === "general" && <GeneralSettings theme={theme} setTheme={setTheme} />}
                {tab === "shortcuts" && <ShortcutsSettings />}
                {tab === "ai" && <AnnotationSettings />}
                {tab === "repaint" && <RepaintSettings />}
                {tab === "people" && <PeopleSettings />}
                {tab === "watermark" && <WatermarkSettings />}
                {tab === "library" && (
                  <LibrarySettings info={info} summary={summary} onSwitchCatalog={onSwitchCatalog} onClose={onClose} />
                )}
                {tab === "integrations" && <IntegrationsSettings />}
                {tab === "about" && <AboutSettings />}
              </>
            );
            const entry = TABS.find((x) => x.id === tab);
            return api.can(entry?.cap) ? pane : <DesktopOnlyPane>{pane}</DesktopOnlyPane>;
          })()}
        </div>
      </div>
    </Modal>
  );
}
