import { useTranslation } from "react-i18next";
import i18n, { SUPPORTED_LOCALES } from "../../i18n";
import api from "../../api";
import { FieldRow, Group } from "./SettingsPrimitives";

// General app settings: interface language + color theme.
export default function GeneralSettings({ theme = "dark", setTheme }) {
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
      <Group>
      <FieldRow label={t("general.language")} hint={t("general.languageHint")}>
        <select
          value={current}
          onChange={(e) => changeLanguage(e.target.value)}
          className="h-7 max-w-[180px] rounded-md border border-border/60 bg-app px-1.5 text-[11px] text-text outline-none hover:border-border focus:border-accent/50"
        >
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l} value={l}>{tc(`language.${l}`)}</option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label={t("general.theme")} hint={t("general.themeHint")}>
        <select
          value={theme}
          onChange={(e) => setTheme?.(e.target.value)}
          className="h-7 max-w-[180px] rounded-md border border-border/60 bg-app px-1.5 text-[11px] text-text outline-none hover:border-border focus:border-accent/50"
        >
          <option value="dark">{t("general.themeDark")}</option>
          <option value="light">{t("general.themeLight")}</option>
          <option value="system">{t("general.themeSystem")}</option>
        </select>
      </FieldRow>
      </Group>
    </div>
  );
}
