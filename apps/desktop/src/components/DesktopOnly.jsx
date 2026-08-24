// "Available in the desktop app" affordances for the web build. Locked
// entries stay VISIBLE so users see what the desktop version offers; the
// interaction becomes "open the download page". On desktop no capability is
// ever locked, so none of this renders there.
import { useTranslation } from "react-i18next";
import api from "../api";

export const DESKTOP_SITE_URL = "https://yiwang3.github.io/AfterFrame/";

export function openDesktopSite() {
  if (api.has("openExternal")) api.openExternal(DESKTOP_SITE_URL);
  else window.open(DESKTOP_SITE_URL, "_blank", "noopener");
}

// Small tag appended to a locked entry's label.
export function DesktopBadge({ className = "" }) {
  const { t } = useTranslation("common");
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-sm border border-border/70 px-1 py-px text-[8px] font-semibold uppercase tracking-wider text-muted2 ${className}`}
    >
      {t("desktop.badge")}
    </span>
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
