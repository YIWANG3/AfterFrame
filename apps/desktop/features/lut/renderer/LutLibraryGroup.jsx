// Settings → Library → LUT library (docs/lut-plan.md §1): where imported
// LUTs are kept and how much room they take, a way to empty it (to the Trash),
// and the folders read in place. The editor's LUT panel imports; this is
// where the space they take is seen and given back.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderPlus, Trash2, X } from "lucide-react";
import api from "../../../src/api";
import { confirm } from "../../../src/components/confirm";
import { fileName, formatBytes } from "../../../src/utils/format";
import { Group, FieldRow, SecondaryButton, IconActionButton } from "../../../src/components/settings/SettingsPrimitives";

export default function LutLibraryGroup() {
  const { t } = useTranslation("lut");
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listLuts();
      setState({ library: res.library, folders: res.folders });
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const count = state?.library?.count || 0;
  const size = formatBytes(state?.library?.bytes) || "0 MB";

  async function clear() {
    const ok = await confirm({
      title: t("settings.clearTitle"),
      message: t("settings.clearMessage", { count }),
      confirmLabel: t("settings.clearConfirm"),
      cancelLabel: t("cancel"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.clearLutLibrary();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    const res = await api.addLutFolder(null);
    if (!res?.canceled) await refresh();
  }

  async function removeFolder(folder) {
    await api.removeLutFolder(folder);
    await refresh();
  }

  // A folder that moved: point at where it is now (no file is touched).
  async function relocateFolder(folder) {
    const res = await api.addLutFolder(null);
    if (res?.canceled || res?.error) return;
    if (res?.folder && res.folder !== folder) await api.removeLutFolder(folder);
    await refresh();
  }

  return (
    <Group title={t("settings.title")} subtitle={t("settings.subtitle")}>
      <FieldRow
        label={t("settings.library")}
        hint={state ? t("settings.libraryHint", { count, size }) : t("settings.libraryLoading")}
      >
        <SecondaryButton onClick={() => void api.openCacheDir("luts")}>
          <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t("settings:library.openFolder")}</span>
        </SecondaryButton>
        <SecondaryButton onClick={clear} disabled={busy || count === 0}>
          <span className="inline-flex items-center gap-1.5" data-testid="settings-clear-luts"><Trash2 className="h-3.5 w-3.5" />{t("settings.clear")}</span>
        </SecondaryButton>
      </FieldRow>
      <FieldRow label={t("settings.folders")} hint={t("settings.foldersHint")}>
        <SecondaryButton onClick={addFolder}>
          <span className="inline-flex items-center gap-1.5"><FolderPlus className="h-3.5 w-3.5" />{t("settings.addFolder")}</span>
        </SecondaryButton>
      </FieldRow>
      {(state?.folders || []).map((folder) => (
        <FieldRow
          key={folder.path}
          label={fileName(folder.path) || folder.path}
          hint={folder.available
            ? t("settings.folderHint", { path: folder.path, count: folder.count })
            : t("settings.folderUnavailable", { path: folder.path })}
        >
          {folder.available ? (
            <SecondaryButton onClick={() => void api.revealPath(folder.path)}>
              <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t("settings:library.openFolder")}</span>
            </SecondaryButton>
          ) : (
            <SecondaryButton onClick={() => relocateFolder(folder.path)}>{t("settings.relocateFolder")}</SecondaryButton>
          )}
          {/* Stops reading the folder; its files are left alone. */}
          <IconActionButton title={t("settings.removeFolder")} onClick={() => removeFolder(folder.path)}><X /></IconActionButton>
        </FieldRow>
      ))}
    </Group>
  );
}
