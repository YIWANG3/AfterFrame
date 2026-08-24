// "Available in the desktop app" affordances for the web build. Locked
// entries stay VISIBLE but inert (dimmed + tooltip) so users see what the
// desktop version offers without stray navigation; the single conversion
// entry point is DesktopHint in the sidebar. On desktop no capability is
// ever locked, so none of this renders there.
import { useTranslation } from "react-i18next";
import { MonitorDown } from "lucide-react";
import api from "../api";

export const DESKTOP_SITE_URL = "https://yiwang3.github.io/AfterFrame/";

export function openDesktopSite() {
  if (api.has("openExternal")) api.openExternal(DESKTOP_SITE_URL);
  else window.open(DESKTOP_SITE_URL, "_blank", "noopener");
}

// Global "try the desktop app" entry — the ONE clickable conversion surface.
// Renders only on the web bridge; sits in the sidebar above Settings.
export function DesktopHint() {
  const { t } = useTranslation("common");
  if (!api.capabilities.web) return null;
  return (
    <button
      type="button"
      onClick={openDesktopSite}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-accent/90 transition-colors hover:bg-hover/70 hover:text-accent"
    >
      <MonitorDown className="h-4 w-4 stroke-[1.6]" />
      <span className="text-[13px]">{t("desktop.try")}</span>
    </button>
  );
}

// Wraps a whole pane (settings tab) that only functions on desktop: a banner
// links to the download; the content stays visible but dimmed and inert.
export function DesktopOnlyPane({ children }) {
  const { t } = useTranslation("common");
  return (
    <div>
      <button
        type="button"
        onClick={openDesktopSite}
        className="mb-5 flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-app px-3.5 py-2.5 text-left transition-colors hover:border-accent/40"
      >
        <span className="text-[12px] text-muted">{t("desktop.hint")}</span>
        <span className="shrink-0 text-[12px] font-medium text-accent">{t("desktop.get")}</span>
      </button>
      <div className="pointer-events-none select-none opacity-45" aria-disabled="true">
        {children}
      </div>
    </div>
  );
}
