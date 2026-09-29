// Settings › Watermark: the name frame text uses for {author}, and the frame
// templates the user saved from the editor (Text › Border › Save as template).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Trash2 } from "lucide-react";
import api from "../../api";
import { confirm } from "../confirm";
import { FieldRow, Group, IconActionButton, TextInput } from "./SettingsPrimitives";

export default function WatermarkSettings() {
  const { t } = useTranslation("settings");
  const [author, setAuthor] = useState("");
  const savedAuthor = useRef("");
  const [justSaved, setJustSaved] = useState(false);
  const [templates, setTemplates] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [profile, list] = await Promise.all([
        api.getWatermarkProfile().catch(() => null),
        api.listFrameTemplates().catch(() => []),
      ]);
      if (!alive) return;
      savedAuthor.current = profile?.author || "";
      setAuthor(savedAuthor.current);
      setTemplates(Array.isArray(list) ? list : []);
    })();
    return () => { alive = false; };
  }, []);

  async function saveAuthor() {
    if (author.trim() === savedAuthor.current) return;
    const next = await api.saveWatermarkProfile({ author });
    savedAuthor.current = next?.author ?? author.trim();
    setAuthor(savedAuthor.current);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1600);
  }

  async function remove(tpl) {
    const ok = await confirm({
      title: t("watermark.deleteTitle", { name: tpl.name }), message: t("watermark.deleteMessage"),
      confirmLabel: t("watermark.delete"), cancelLabel: t("actions.cancel", { ns: "common" }), danger: true,
    });
    if (!ok) return;
    const next = await api.saveFrameTemplates(templates.filter((x) => x.id !== tpl.id));
    setTemplates(Array.isArray(next) ? next : []);
  }

  return (
    <>
      <Group title={t("watermark.profileTitle")} subtitle={t("watermark.profileSubtitle")}>
        <FieldRow label={t("watermark.author")} hint={t("watermark.authorHint")}>
          {justSaved && <Check className="h-3.5 w-3.5 text-accent" aria-label={t("watermark.saved")} />}
          <TextInput
            value={author}
            onChange={setAuthor}
            onBlur={saveAuthor}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            placeholder={t("watermark.authorPlaceholder")}
            maxLength={80}
            className="w-56"
            data-watermark-author="true"
          />
        </FieldRow>
      </Group>
      <Group title={t("watermark.templatesTitle")} subtitle={t("watermark.templatesSubtitle")}>
        {templates && templates.length === 0 && (
          <div className="py-3 text-[11px] text-muted2">{t("watermark.templatesEmpty")}</div>
        )}
        {(templates || []).map((tpl) => (
          <div key={tpl.id} data-settings-frame-template={tpl.id} className="flex items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-b-0">
            <span className="min-w-0 truncate text-[12px] text-text">{tpl.name}</span>
            <IconActionButton onClick={() => remove(tpl)} title={t("watermark.delete")} danger>
              <Trash2 className="h-3.5 w-3.5" />
            </IconActionButton>
          </div>
        ))}
      </Group>
    </>
  );
}
