import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, { SUPPORTED_LOCALES } from "../../i18n";
import api from "../../api";
import { FieldRow, Group } from "./SettingsPrimitives";
import SettingsTransfer from "./SettingsTransfer";
import { Select } from "../../ui";

// General app settings: interface language, color theme, interface scale,
// backup & transfer.

// The choices electron/uiScale.js accepts (the window's page zoom).
const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25];
export default function GeneralSettings({ theme = "dark", setTheme }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const current = i18n.language;
  const [uiScale, setUiScaleState] = useState(1);
  useEffect(() => {
    let alive = true;
    const read = () => Promise.resolve(api.getUiScale?.()).then((v) => { if (alive && v) setUiScaleState(Number(v)); }).catch(() => {});
    read();
    // ⌘= / ⌘- / ⌘0 change the zoom from the menu while this row is open; a
    // zoom change resizes the page, so re-read it then.
    window.addEventListener("resize", read);
    return () => { alive = false; window.removeEventListener("resize", read); };
  }, []);

  async function changeUiScale(value) {
    const next = Number(value);
    setUiScaleState(next);
    try {
      const applied = await api.setUiScale(next);
      if (applied) setUiScaleState(Number(applied));
    } catch { /* stays at the old zoom */ }
  }

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
        <Select size="md" value={current} onChange={changeLanguage} className="max-w-[180px]">
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l} value={l}>{tc(`language.${l}`)}</option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label={t("general.theme")} hint={t("general.themeHint")}>
        <Select size="md" value={theme} onChange={(v) => setTheme?.(v)} className="max-w-[180px]">
          <option value="dark">{t("general.themeDark")}</option>
          <option value="light">{t("general.themeLight")}</option>
          <option value="system">{t("general.themeSystem")}</option>
        </Select>
      </FieldRow>

      <FieldRow label={t("general.uiScale")} hint={t("general.uiScaleHint")}>
        <Select size="md" value={String(uiScale)} onChange={changeUiScale} className="max-w-[180px]" data-testid="ui-scale">
          {UI_SCALES.map((s) => (
            <option key={s} value={String(s)}>{`${Math.round(s * 100)}%`}</option>
          ))}
        </Select>
      </FieldRow>
      </Group>
      <SettingsTransfer theme={theme} />
    </div>
  );
}
