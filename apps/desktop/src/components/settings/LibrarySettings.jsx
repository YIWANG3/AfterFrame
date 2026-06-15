import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Group, FieldRow, Toggle } from "./SettingsPrimitives";

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
        <FieldRow label={t("library.previewThumbnails")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label={t("library.depthMaps")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label={t("library.stickerLibrary")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
      </Group>
    </div>
  );
}
