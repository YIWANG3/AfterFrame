import { useTranslation } from "react-i18next";
import { FolderPlus, FolderOpen } from "lucide-react";
import logo from "../assets/logo.png";

/* First-run / no-catalog state. In packaged mode there is no default catalog,
   so a fresh install has none open — browsing is silently empty and importing
   would fail against a null catalog. This fills the gallery pane (sidebar +
   menu stay reachable) and makes the next step explicit: create a catalog or
   open an existing one. App renders it when info.catalogPath is empty. */
export default function WelcomeOverlay({ onCreate, onOpen }) {
  const { t } = useTranslation("app");

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="flex w-[460px] max-w-[90vw] flex-col items-center text-center">
        <img src={logo} alt="AfterFrame" className="h-20 w-20 rounded-2xl" />
        <h1 className="mt-5 text-[20px] font-semibold text-text">{t("welcome.title")}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("welcome.subtitle")}</p>

        <div className="mt-7 flex w-full flex-col gap-2.5">
          <button
            type="button"
            onClick={onCreate}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-accent bg-accent text-[13px] font-semibold text-app transition-colors hover:bg-accent/90 focus:outline-none"
          >
            <FolderPlus className="h-4 w-4" />
            {t("welcome.create")}
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-panel text-[13px] text-text transition-colors hover:bg-hover focus:outline-none"
          >
            <FolderOpen className="h-4 w-4" />
            {t("welcome.open")}
          </button>
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-muted2">{t("welcome.explainer")}</p>
      </div>
    </div>
  );
}
