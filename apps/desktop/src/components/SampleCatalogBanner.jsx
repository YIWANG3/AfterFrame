import { useTranslation } from "react-i18next";
import { Info, FolderPlus, RotateCcw } from "lucide-react";
import Button from "../ui/Button";

/* Floating pill at the bottom of the gallery while the sample catalog is
   open. Makes clear the photos are demo data (not the user's own), invites
   free experimentation, and offers the two exits: create a real catalog or
   reset the sample to its shipped state. App renders it when
   info.isSampleCatalog is true. Bottom-center keeps clear of the JobDock
   and toasts (bottom-right). */
export default function SampleCatalogBanner({ onCreateOwn, onReset, busy = false }) {
  const { t } = useTranslation("app");

  return (
    <div className="sample-catalog-dock pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="sample-catalog-banner pointer-events-auto flex max-w-full items-center gap-3 rounded-[18px] p-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1">
          <Info className="h-4 w-4 shrink-0 text-muted" />
          <p className="text-[12px] leading-5 text-text">{t("sample.banner")}</p>
        </div>
        <div className="catalog-actions flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            onClick={onCreateOwn}
            variant="primary"
            className="catalog-action"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("sample.createOwn")}
          </Button>
          <Button
            type="button"
            onClick={onReset}
            disabled={busy}
            variant="soft"
            className="catalog-action"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("sample.reset")}
          </Button>
        </div>
      </div>
    </div>
  );
}
