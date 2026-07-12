import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import api from "../../api";
import { Group, FieldRow } from "./SettingsPrimitives";

// Integrations that belong to this app installation. Catalog-specific watched
// directories live in Library so their ownership is visible at the point of use.
export default function IntegrationsSettings() {
  const { t } = useTranslation("settings");
  const [editors, setEditors] = useState([]);

  useEffect(() => {
    Promise.resolve(api.detectEditors?.()).then((l) => setEditors(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  return (
    <div>
      <Group title={t("integrations.editorsTitle")} subtitle={t("integrations.editorsSubtitle")}>
        {editors.length === 0 ? (
          <div className="py-3 text-[11px] text-muted2">{t("integrations.noEditors")}</div>
        ) : (
          editors.map((e) => (
            <FieldRow key={e.appPath} label={e.label} hint={e.appPath}>
              <ExternalLink className="h-3.5 w-3.5 text-muted2" />
            </FieldRow>
          ))
        )}
      </Group>

    </div>
  );
}
