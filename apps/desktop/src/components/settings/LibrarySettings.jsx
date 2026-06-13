import { useTranslation } from "react-i18next";
import { Group, FieldRow } from "./SettingsPrimitives";

export default function LibrarySettings() {
  const { t } = useTranslation("settings");
  return (
    <div>
      <Group title={t("library.currentCatalog")}>
        <div className="py-3 text-[11px] text-muted2">{t("library.comingSoon")}</div>
      </Group>
      <Group title={t("library.cacheStorage")} subtitle={t("library.cacheSubtitle")}>
        <FieldRow label={t("library.previewThumbnails")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label={t("library.depthMaps")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label={t("library.stickerLibrary")}><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
      </Group>
    </div>
  );
}
