// Settings › Watermark: the name frame text uses for {author}, the user's own
// logos, and the frame templates saved from the editor (Text › Border › Save
// as template).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import api from "../../api";
import { confirm } from "../confirm";
import InlineEdit from "../InlineEdit";
import { localFileUrl } from "../../utils/format";
import { invalidatePersonalLogos } from "../editor/render/personalLogos";
import { FieldRow, Group, IconActionButton, SecondaryButton, TextInput } from "./SettingsPrimitives";

export default function WatermarkSettings() {
  const { t } = useTranslation("settings");
  const [author, setAuthor] = useState("");
  const savedAuthor = useRef("");
  const [justSaved, setJustSaved] = useState(false);
  const [templates, setTemplates] = useState(null);
  const [logos, setLogos] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [logoError, setLogoError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [profile, list, mine] = await Promise.all([
        api.getWatermarkProfile().catch(() => null),
        api.listFrameTemplates().catch(() => []),
        api.listPersonalLogos().catch(() => null),
      ]);
      if (!alive) return;
      savedAuthor.current = profile?.author || "";
      setAuthor(savedAuthor.current);
      setTemplates(Array.isArray(list) ? list : []);
      setLogos(Array.isArray(mine?.logos) ? mine.logos : []);
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

  // Logos: every change also drops the editor's cached copies.
  function logosChanged(next) {
    invalidatePersonalLogos();
    if (Array.isArray(next?.logos)) setLogos(next.logos);
  }
  async function importLogo() {
    setLogoError(null);
    const res = await api.importPersonalLogo();
    if (res?.error) { setLogoError(res); return; }
    if (res?.canceled) return;
    logosChanged(await api.listPersonalLogos());
  }
  async function removeLogo(logo) {
    const ok = await confirm({
      title: t("watermark.deleteLogoTitle", { name: logo.name }), message: t("watermark.deleteLogoMessage"),
      confirmLabel: t("watermark.delete"), cancelLabel: t("actions.cancel", { ns: "common" }), danger: true,
    });
    if (ok) logosChanged(await api.deletePersonalLogo(logo.id));
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
      <Group title={t("watermark.logosTitle")} subtitle={t("watermark.logosSubtitle")}>
        {(logos || []).map((logo) => (
          <div key={logo.id} data-settings-logo={logo.id} className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-b-0">
            <div className="flex h-8 w-20 shrink-0 items-center justify-center rounded bg-[var(--fill-2)] p-1">
              <img src={localFileUrl(logo.path)} alt="" className="max-h-full max-w-full object-contain" />
            </div>
            <div className="min-w-0 flex-1">
              {renaming === logo.id ? (
                <div className="rounded border border-border bg-app text-[12px]">
                  <InlineEdit
                    initial={logo.name}
                    onConfirm={async (name) => { setRenaming(null); logosChanged(await api.renamePersonalLogo(logo.id, name)); }}
                    onCancel={() => setRenaming(null)}
                  />
                </div>
              ) : (
                <span className="block truncate text-[12px] text-text">{logo.name}</span>
              )}
              <span className="text-[10.5px] text-muted2">{logo.tintable ? t("watermark.logoTintable") : t("watermark.logoFixed")}</span>
            </div>
            <IconActionButton onClick={() => setRenaming(logo.id)} title={t("watermark.rename")}>
              <Pencil className="h-3.5 w-3.5" />
            </IconActionButton>
            <IconActionButton onClick={() => removeLogo(logo)} title={t("watermark.delete")} danger>
              <Trash2 className="h-3.5 w-3.5" />
            </IconActionButton>
          </div>
        ))}
        {api.has("importPersonalLogo") && (
          <div className="py-3">
            <SecondaryButton onClick={importLogo}>
              <span className="flex items-center gap-1" data-settings-import-logo="true"><Plus className="h-3.5 w-3.5" />{t("watermark.importLogo")}</span>
            </SecondaryButton>
            {logoError && (
              <div className="mt-1.5 text-[11px] text-error">
                {t(`watermark.logoErrors.${logoError.error}`, { message: logoError.message || "", defaultValue: t("watermark.logoErrors.failed", { message: logoError.error }) })}
              </div>
            )}
          </div>
        )}
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
