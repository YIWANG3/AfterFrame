// Settings › General › Sidebar: every entry the sidebar can hide, in its
// order, each with a switch (components/sidebarLayout.js). All Assets is not
// listed: it can't be hidden.
import { useTranslation } from "react-i18next";
import { Toggle } from "../../ui";
import { sidebarViews } from "../../../features/index.js";
import { SIDEBAR_ENTRIES, setSidebarHidden, useSidebarHidden } from "../sidebarLayout";
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
  const entries = SIDEBAR_ENTRIES.flatMap((id) => (
    id === "@views" ? sidebarViews.map((view) => ({ id: view.id, labelKey: view.labelKey })) : [{ id, labelKey: LABELS[id] }]
  ));
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
