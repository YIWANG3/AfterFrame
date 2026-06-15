import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Group, FieldRow, Toggle } from "./SettingsPrimitives";

function OpenFolderButton({ kind, label }) {
  return (
    <button
      type="button"
      onClick={() => void window.mediaWorkspace?.openCacheDir?.(kind)}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text focus:outline-none"
    >
      <FolderOpen className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export default function LibrarySettings() {
  const { t } = useTranslation("settings");
  const [generateHd, setGenerateHd] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = (await window.mediaWorkspace?.getPreviewSettings?.()) || {};
      if (!cancelled) setGenerateHd(stored.generateHd === true);
    })();
    return () => { cancelled = true; };
  }, []);

  const setHd = useCallback((value) => {
    setGenerateHd(value);
    void window.mediaWorkspace?.savePreviewSettings?.({ generateHd: value });
  }, []);

  return (
    <div>
      <Group title={t("library.currentCatalog")}>
        <div className="py-3 text-[11px] text-muted2">{t("library.comingSoon")}</div>
      </Group>
      <Group title={t("library.previewsTitle")}>
        <FieldRow label={t("library.generateHd")} hint={t("library.generateHdHint")}>
          <Toggle on={generateHd} onChange={setHd} />
        </FieldRow>
      </Group>
      <Group title={t("library.cacheStorage")} subtitle={t("library.cacheSubtitle")}>
        <FieldRow label={t("library.depthMaps")} hint={t("library.depthMapsHint")}>
          <OpenFolderButton kind="depth" label={t("library.openFolder")} />
        </FieldRow>
        <FieldRow label={t("library.stickerLibrary")} hint={t("library.stickerLibraryHint")}>
          <OpenFolderButton kind="stickers" label={t("library.openFolder")} />
        </FieldRow>
        <FieldRow label={t("library.videoProxies")} hint={t("library.videoProxiesHint")}>
          <OpenFolderButton kind="videoProxies" label={t("library.openFolder")} />
        </FieldRow>
      </Group>
    </div>
  );
}
