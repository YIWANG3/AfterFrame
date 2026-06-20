import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, ExternalLink } from "lucide-react";
import api from "../../api";
import { Group, FieldRow, SecondaryButton } from "./SettingsPrimitives";

function baseName(p) {
  return String(p).split("/").filter(Boolean).pop() || String(p);
}

// Integrations: external editors (auto-detected) + watched directories
// (auto-import). See docs/integration-plan.md.
export default function IntegrationsSettings() {
  const { t } = useTranslation("settings");
  const [editors, setEditors] = useState([]);
  const [watched, setWatched] = useState([]);

  useEffect(() => {
    Promise.resolve(api.detectEditors?.()).then((l) => setEditors(Array.isArray(l) ? l : [])).catch(() => {});
    Promise.resolve(api.getWatchedDirs?.()).then((l) => setWatched(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  const addDir = useCallback(async () => {
    const picked = await api.pickDirectories?.("image");
    if (!picked?.length) return;
    let next = watched;
    for (const p of picked) next = await api.addWatchedDir(p); // main validates it's a dir
    setWatched(Array.isArray(next) ? next : []);
  }, [watched]);

  const removeDir = useCallback(async (dir) => {
    const next = await api.removeWatchedDir(dir);
    setWatched(Array.isArray(next) ? next : []);
  }, []);

  return (
    <div>
      <div className="mb-5 border-b border-border pb-4">
        <div className="text-[18px] font-semibold text-text">{t("integrations.title")}</div>
      </div>

      <Group title={t("integrations.editorsTitle")} subtitle={t("integrations.editorsSubtitle")}>
        {editors.length === 0 ? (
          <div className="py-3 text-[11px] text-muted2">{t("integrations.noEditors")}</div>
        ) : (
          editors.map((e) => (
            <FieldRow key={e.appPath} label={e.label} hint={e.appPath}>
              <ExternalLink className="h-3.5 w-3.5 text-muted2" />
            </FieldRow>
          ))
        )}
      </Group>

      <Group title={t("integrations.watchedTitle")} subtitle={t("integrations.watchedSubtitle")}>
        {watched.length === 0 ? (
          <div className="py-3 text-[11px] text-muted2">{t("integrations.noWatched")}</div>
        ) : (
          watched.map((dir) => (
            <FieldRow key={dir} label={baseName(dir)} hint={dir}>
              <SecondaryButton onClick={() => removeDir(dir)}>{t("integrations.remove")}</SecondaryButton>
            </FieldRow>
          ))
        )}
        <div className="py-3">
          <SecondaryButton onClick={addDir}>
            <span className="inline-flex items-center gap-1.5">
              <FolderPlus className="h-3.5 w-3.5" />
              {t("integrations.addFolder")}
            </span>
          </SecondaryButton>
        </div>
      </Group>
    </div>
  );
}
