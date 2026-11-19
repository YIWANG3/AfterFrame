// The manager page's tabs: Smart Collections, Collections, Folders. Each
// tab keeps its own toolbar (search, sort, view); this sits where the
// page's title used to, with how many each holds.
import { useTranslation } from "react-i18next";

export const MANAGER_TABS = ["smart", "collections", "folders"];

export default function ManagerTabs({ tab, onTab, counts = {} }) {
  const { t } = useTranslation("nav");
  const labels = { smart: t("sidebar.smartCollections"), collections: t("sidebar.collections"), folders: t("sidebar.folders") };
  return (
    <div role="tablist" aria-label={t("manager.tabs")} className="flex shrink-0 items-center rounded-lg bg-[var(--fill-2)] p-0.5" data-testid="manager-tabs">
      {MANAGER_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          data-testid={`manager-tab-${id}`}
          onClick={() => onTab(id)}
          className={[
            "flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] transition-colors",
            tab === id ? "bg-selected text-text" : "text-muted hover:text-text",
          ].join(" ")}
        >
          <span>{labels[id]}</span>
          <span className={`tabular-nums ${tab === id ? "text-muted" : "text-muted3"}`}>{counts[id] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
