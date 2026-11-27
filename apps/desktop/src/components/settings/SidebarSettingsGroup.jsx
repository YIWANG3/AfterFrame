// Settings › General › Sidebar: every entry the sidebar can hide, in the
// order the sidebar shows them (the user's, when they dragged them), each
// with a switch (components/sidebarLayout.js). All Assets is not listed: it
// can't be hidden.
import { useTranslation } from "react-i18next";
import { Toggle } from "../../ui";
import { sidebarViews } from "../../../features/index.js";
import { setSidebarHidden, useSidebarHidden, useSidebarOrder } from "../sidebarLayout";
import { FieldRow, Group } from "./SettingsPrimitives";

const LABELS = {
  recent: "nav:browse.recent",
  rated: "nav:browse.rated",
  lookalikes: "nav:browse.lookalikes",
  discover: "nav:sidebar.discover",
  people: "nav:sidebar.people",
  tags: "nav:sidebar.tags",
  stats: "nav:sidebar.stats",
  smartCollections: "nav:sidebar.smartCollections",
  collections: "nav:sidebar.collections",
  diskFolders: "nav:sidebar.folders",
};

export default function SidebarSettingsGroup() {
  const { t } = useTranslation(["settings", "nav"]);
  const hidden = useSidebarHidden();
  const order = useSidebarOrder(sidebarViews.map((view) => view.id));
  const viewLabels = Object.fromEntries(sidebarViews.map((view) => [view.id, view.labelKey]));
  const entries = [...order.entries, ...order.sections].map((id) => ({ id, labelKey: LABELS[id] || viewLabels[id] }));
  return (
    <Group title={t("general.sidebar")}>
      <div data-testid="sidebar-settings">
        {entries.map(({ id, labelKey }) => (
          <FieldRow key={id} label={t(labelKey)}>
            <span data-sidebar-entry={id}>
              <Toggle on={!hidden.has(id)} onChange={(on) => setSidebarHidden(id, !on)} />
            </span>
          </FieldRow>
        ))}
      </div>
    </Group>
  );
}
