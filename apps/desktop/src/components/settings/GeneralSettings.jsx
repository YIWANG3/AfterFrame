import { useTranslation } from "react-i18next";
import i18n, { SUPPORTED_LOCALES } from "../../i18n";
import api from "../../api";

// General app settings. For now just the interface language; theme and other
// global prefs can move here later.
export default function GeneralSettings() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const current = i18n.language;

  async function changeLanguage(lng) {
    if (lng === current) return;
    await i18n.changeLanguage(lng);
    // Persist + flip the (main-process) menu to match.
    try { await api.setLocale(lng); } catch { /* menu stays until restart */ }
  }

  return (
    <div>
      <div className="mb-5 border-b border-border pb-4">
        <div className="text-[18px] font-semibold text-text">{t("general.title")}</div>
      </div>

      <div className="flex items-center justify-between border-b border-border/50 py-3">
        <div>
          <div className="text-[12px] text-text">{t("general.language")}</div>
          <div className="mt-0.5 text-[10px] text-muted2">{t("general.languageHint")}</div>
        </div>
        <select
          value={current}
          onChange={(e) => changeLanguage(e.target.value)}
          className="h-7 max-w-[180px] rounded-md border border-border/60 bg-app px-1.5 text-[11px] text-text outline-none hover:border-border focus:border-accent/50"
        >
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l} value={l}>{tc(`language.${l}`)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
