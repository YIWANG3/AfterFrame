// Settings → Library → LUT library (docs/lut-plan.md §1): where imported
// LUTs are kept and how much room they take, a way to empty it (to the Trash),
// and the folders read in place. The editor's LUT panel imports; this is
// where the space they take is seen and given back.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderPlus, Trash2, X } from "lucide-react";
import api from "../../api";
import { confirm } from "../confirm";
import { fileName, formatBytes } from "../../utils/format";
import { Group, FieldRow, SecondaryButton, IconActionButton } from "./SettingsPrimitives";

export default function LutLibraryGroup() {
  const { t } = useTranslation("settings");
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
      title: t("library.clearLutsTitle"),
      message: t("library.clearLutsMessage", { count }),
      confirmLabel: t("library.clearLutsConfirm"),
      cancelLabel: t("library.cancel"),
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
    <Group title={t("library.lutTitle")} subtitle={t("library.lutSubtitle")}>
      <FieldRow
        label={t("library.lutLibrary")}
        hint={state ? t("library.lutLibraryHint", { count, size }) : t("library.lutLibraryLoading")}
      >
        <SecondaryButton onClick={() => void api.openCacheDir("luts")}>
          <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t("library.openFolder")}</span>
        </SecondaryButton>
        <SecondaryButton onClick={clear} disabled={busy || count === 0}>
          <span className="inline-flex items-center gap-1.5" data-testid="settings-clear-luts"><Trash2 className="h-3.5 w-3.5" />{t("library.clearLuts")}</span>
        </SecondaryButton>
      </FieldRow>
      <FieldRow label={t("library.lutFolders")} hint={t("library.lutFoldersHint")}>
        <SecondaryButton onClick={addFolder}>
          <span className="inline-flex items-center gap-1.5"><FolderPlus className="h-3.5 w-3.5" />{t("library.addLutFolder")}</span>
        </SecondaryButton>
      </FieldRow>
      {(state?.folders || []).map((folder) => (
        <FieldRow
          key={folder.path}
          label={fileName(folder.path) || folder.path}
          hint={folder.available
            ? t("library.lutFolderHint", { path: folder.path, count: folder.count })
            : t("library.lutFolderUnavailable", { path: folder.path })}
        >
          {folder.available ? (
            <SecondaryButton onClick={() => void api.revealPath(folder.path)}>
              <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t("library.openFolder")}</span>
            </SecondaryButton>
          ) : (
            <SecondaryButton onClick={() => relocateFolder(folder.path)}>{t("library.relocateLutFolder")}</SecondaryButton>
          )}
          {/* Stops reading the folder; its files are left alone. */}
          <IconActionButton title={t("library.removeLutFolder")} onClick={() => removeFolder(folder.path)}><X /></IconActionButton>
        </FieldRow>
      ))}
    </Group>
  );
}
