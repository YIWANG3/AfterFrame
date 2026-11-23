// The manager page's tabs: Smart Collections, Collections, Folders. They sit
// where the gallery's title does, in its type (the skin's
// `.app-toolbar .truncate.font-semibold`): the current one reads as the
// title, the others in grey beside it. Each tab keeps its own toolbar.
import { useTranslation } from "react-i18next";

export const MANAGER_TABS = ["smart", "collections", "folders"];

export default function ManagerTabs({ tab, onTab, counts = {} }) {
  const { t } = useTranslation("nav");
  const labels = { smart: t("sidebar.smartCollections"), collections: t("sidebar.collections"), folders: t("sidebar.folders") };
  return (
    <div role="tablist" aria-label={t("manager.tabs")} className="flex min-w-0 items-baseline gap-4 overflow-hidden" data-testid="manager-tabs">
      {MANAGER_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          data-testid={`manager-tab-${id}`}
          onClick={() => onTab(id)}
          className={[
            "flex min-w-0 shrink-0 items-baseline gap-1.5 bg-transparent p-0 transition-colors",
            tab === id ? "text-text" : "text-muted2 hover:text-muted",
          ].join(" ")}
        >
          <span className="truncate text-[13px] font-semibold tracking-[-0.01em]">{labels[id]}</span>
          <span className="text-[12px] tabular-nums text-muted3">{counts[id] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
