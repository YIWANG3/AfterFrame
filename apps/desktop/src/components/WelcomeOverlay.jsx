import { useTranslation } from "react-i18next";
import { FolderPlus, FolderOpen, Images, Loader2 } from "lucide-react";
import logo from "../assets/logo.png";
import Button from "../ui/Button";

/* First-run / no-catalog state. In packaged mode there is no default catalog,
   so a fresh install has none open — browsing is silently empty and importing
   would fail against a null catalog. This fills the gallery pane (sidebar +
   menu stay reachable) and makes the next step explicit: create a catalog,
   open an existing one, or browse the bundled sample library (created on
   first click — see openSampleCatalog in main). App renders it when
   info.catalogPath is empty. */
export default function WelcomeOverlay({ onCreate, onOpen, onSample, sampleBusy = false, web = false }) {
  const { t } = useTranslation("app");

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="flex w-[440px] max-w-full flex-col items-center text-center">
        <img src={logo} alt="AfterFrame" className="h-20 w-20 rounded-2xl" />
        <h1 className="mt-5 text-[20px] font-semibold text-text">{t("welcome.title")}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t(web ? "welcome.webSubtitle" : "welcome.subtitle")}</p>

        <div className="catalog-actions welcome-actions mt-7 flex w-full max-w-[360px] flex-col gap-2.5">
          {!web && <>
          <Button
            type="button"
            onClick={onCreate}
            variant="primary"
            className="catalog-action w-full"
          >
            <FolderPlus className="h-4 w-4" />
            {t("welcome.create")}
          </Button>
          <Button
            type="button"
            onClick={onOpen}
            variant="soft"
            className="catalog-action w-full"
          >
            <FolderOpen className="h-4 w-4" />
            {t("welcome.open")}
          </Button>
          </>}
          <Button
            type="button"
            onClick={onSample}
            disabled={sampleBusy}
            variant={web ? "primary" : "soft"}
            className="catalog-action w-full"
          >
            {sampleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
            {sampleBusy ? t("welcome.sampleLoading") : t("welcome.sample")}
          </Button>
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-muted2">{t(web ? "welcome.webExplainer" : "welcome.explainer")}</p>
      </div>
    </div>
  );
}
