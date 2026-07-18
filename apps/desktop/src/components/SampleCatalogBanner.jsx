import { useTranslation } from "react-i18next";
import { Info, FolderPlus, RotateCcw } from "lucide-react";

/* Floating pill at the bottom of the gallery while the sample catalog is
   open. Makes clear the photos are demo data (not the user's own), invites
   free experimentation, and offers the two exits: create a real catalog or
   reset the sample to its shipped state. App renders it when
   info.isSampleCatalog is true. Bottom-center keeps clear of the JobDock
   and toasts (bottom-right). */
export default function SampleCatalogBanner({ onCreateOwn, onReset, busy = false }) {
  const { t } = useTranslation("app");

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border border-border/60 bg-panel2/95 py-1.5 pl-3.5 pr-1.5 shadow-overlay backdrop-blur">
        <Info className="h-3.5 w-3.5 shrink-0 text-accent" />
        <p className="min-w-0 truncate text-[12px] text-muted">{t("sample.banner")}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onCreateOwn}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11px] font-semibold text-app transition-colors hover:bg-accent/90 focus:outline-none"
          >
            <FolderPlus className="h-3 w-3" />
            {t("sample.createOwn")}
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-app px-2.5 text-[11px] text-text transition-colors hover:bg-hover focus:outline-none disabled:cursor-default disabled:opacity-60"
          >
            <RotateCcw className="h-3 w-3" />
            {t("sample.reset")}
          </button>
        </div>
      </div>
    </div>
  );
}
